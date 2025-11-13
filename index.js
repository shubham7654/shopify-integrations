require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {
  shopifyApi,
  LATEST_API_VERSION,
  Session,
} = require("@shopify/shopify-api");
const { nodeAdapter } = require("@shopify/shopify-api/adapters/node");
const { razorpayClient } = require("./razorpayClient");
const { countries } = require("country-data");
const cheerio = require("cheerio");

const app = express();

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

app.use(express.urlencoded({ extended: true }));

// Message queue and suppression logic
const CHECK_INTERVAL = 60 * 1000; // 1 minute
const SEND_MESSAGE_DELAY = 60 * 60 * 1000; // Change
const MINUTES_FOR_PAYMENT_CHECK = 120; // Payment check from 2 hours ago
const MINUTES_FOR_ORDER_CHECK = 120 * 60 * 1000; // Order check from 2 hours ago
let isSending = false;
const messageQueue = [];
const processingPayments = new Set();

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  adminApiAccessToken: process.env.SHOPIFY_ADMIN_TOKEN,
  scopes: ["read_orders", "write_orders", "read_checkouts", "read_customers"],
  shop: process.env.SHOPIFY_DOMAIN,
  apiVersion: LATEST_API_VERSION,
  isCustomStoreApp: true,
  hostName: process.env.HOST_NAME,
  adapter: nodeAdapter,
});

const session = new Session({
  id: process.env.SHOPIFY_DOMAIN,
  shop: process.env.SHOPIFY_DOMAIN,
  accessToken: process.env.SHOPIFY_ADMIN_TOKEN,
  state: "active",
  isOnline: false,
});

const client = new shopify.clients.Rest({ session });

const dataFiles = {
  checkouts: path.resolve(__dirname, "debounced-checkouts.json"),
  orders: path.resolve(__dirname, "processed-orders.json"),
  fulfillments: path.resolve(__dirname, "processed-fulfillments.json"),
  payments: path.resolve(__dirname, "processed-payments.json"),
  locks: path.resolve(__dirname, "in-process-locks.json"),
};

// async function getPayments() {
//   const todaysPayments = await razorpayClient.fetchTodaysPayments();
//   if (!todaysPayments || !todaysPayments.items) {
//     console.log("No payments found for today.");
//   } else {
//     const matchingPayments = todaysPayments.items
//       .map((payment) => {
//         if (payment.status !== "captured") return;
//         if (!payment?.notes?.cancelUrl) return;
//         return payment;
//       })
//       .filter((p) => p !== undefined);
//     console.log(matchingPayments.length);
//   }
// }

// getPayments();

// async function getOrders(phoneNumber) {
//   const res = await client.get({
//     path: "orders",
//     query: {
//       fields: "id, checkout_token, cart_token, email, phone, total_price",
//       status: "any",
//       limit: 250,
//     },
//   });

//   const orders = res.body.orders;
//   orders.find((order) => {
//     if (
//       (order.phone &&
//         order.phone.indexOf(0) !== -1 &&
//         order.total_price == "0") ||
//       (order.email &&
//         order.email.indexOf(null) !== -1 &&
//         order.total_price == "8,502.00")
//     ) {
//       console.log(order);
//     }
//   });
// }

// getOrders("8921336443");

function loadSet(filePath, type = "set") {
  try {
    const data = JSON.parse(fs.readFileSync(filePath));
    if (type === "set") return new Set(data);
    return data;
  } catch {
    return type === "set" ? new Set() : {};
  }
}

function saveSet(filePath, dataset, item, type = "set") {
  if (type === "debounced") {
    const { cart_token, checkout } = item;
    if (!cart_token || !checkout) {
      console.warn("Invalid debounced item");
      return;
    }
    dataset[cart_token] = {
      checkout,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(filePath, JSON.stringify(dataset, null, 2));
  } else {
    dataset.add(item);
    fs.writeFileSync(filePath, JSON.stringify(Array.from(dataset)));
  }
}

// --- Locks ---
// Used to prevent multiple processes from handling the same checkout at the same time

function loadLocks() {
  try {
    return JSON.parse(fs.readFileSync(dataFiles.locks));
  } catch {
    return {};
  }
}

function saveLocks(locks) {
  fs.writeFileSync(dataFiles.locks, JSON.stringify(locks, null, 2));
}

function isLocked(id) {
  const locks = loadLocks();
  return Boolean(locks[id]);
}

function lockId(id) {
  const locks = loadLocks();
  if (locks[id]) return false;
  locks[id] = Date.now();
  saveLocks(locks);
  return true;
}

function unlockId(id) {
  const locks = loadLocks();
  delete locks[id];
  saveLocks(locks);
}

// --- Abandoned Checkouts ---
async function processQueue() {
  if (isSending || messageQueue.length === 0) return;
  isSending = true;
  const { checkout } = messageQueue.shift();
  try {
    await handleAbandonedCheckoutMessage(checkout);
  } catch (err) {
    console.error("Abandoned checkout message failed", err);
  } finally {
    isSending = false;
    setImmediate(processQueue);
  }
}

// Function for getting country calling code based on country code
function getDialCode(countryCode) {
  try {
    const country = countries[countryCode];
    return country ? `${country.countryCallingCodes[0]}` : "+91";
  } catch (error) {
    console.error("Error fetching country calling code");
    return null;
  }
}

async function handleAbandonedCheckoutMessage(checkout) {
  if (
    !checkout.email &&
    !checkout?.phone &&
    !checkout.shipping_address?.phone
  ) {
    console.log(
      "Skipping incomplete checkout for sending message (missing contact info)"
    );
    return;
  }

  const name = checkout.shipping_address?.first_name || "Customer";
  const amount = checkout.total_price || "0";
  const abandonedCheckoutUrl = `checkouts/cn/${checkout.cart_token}/information`;
  const countryCode =
    checkout.shipping_address?.country_code ||
    checkout.billing_address?.country_code ||
    checkout.country_code ||
    "IN";

  // Fetch product image
  const variantId = Number(checkout.line_items[0]?.variant_id);
  const productId = Number(checkout.line_items[0]?.product_id);
  const headers = {
    headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
  };

  let imageUrl =
    "https://cdn.shopify.com/s/files/1/0655/1352/1302/files/WhatsApp_Image_2025-05-21_at_21.13.58.jpg";

  try {
    const variantRes = await axios.get(
      `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/variants/${variantId}.json`,
      headers
    );
    const imageId = variantRes.data.variant.image_id;

    const productImagesRes = await axios.get(
      `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/products/${productId}/images.json`,
      headers
    );
    const allImages = productImagesRes.data?.images || [];

    imageUrl = allImages[0]?.src.split("?")[0] || imageUrl;
    if (imageId) {
      const matchedImage = allImages.find((img) => img.id === imageId);
      imageUrl = matchedImage?.src || imageUrl;
    }
  } catch (err) {
    console.error("Failed to fetch product images");
  }

  const dialCode = getDialCode(countryCode);

  let rawPhone = checkout?.shipping_address?.phone || checkout?.phone || "";
  let cleanedPhone = rawPhone.replace(/\s+/g, "").slice(-10);
  const phoneNumberInternationalFormat = dialCode + cleanedPhone;

  const payload = {
    apiKey: process.env.AISENSY_API_KEY,
    campaignName: process.env.AC_CAMPAIGN_NAME,
    destination: phoneNumberInternationalFormat,
    userName: name,
    source: "organic",
    templateParams: [name, amount, abandonedCheckoutUrl],
    media: {
      url: imageUrl,
      filename: "product.jpg",
    },
    buttons: [
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: abandonedCheckoutUrl }],
      },
    ],
  };

  try {
    const response = await axios.post(
      "https://backend.aisensy.com/campaign/t1/api/v2",
      payload
    );
    console.log(
      `Abandoned checkout message sent for cart_token: ${checkout.cart_token}.  Response: ${response.data}`
    );
    console.log(`Abandoned checkout message sent to ${name} (${cleanedPhone})`);
  } catch (err) {
    console.error("Abandoned checkout message error: ", err.response.data);
    console.log(
      `Abandoned checkout message cannot be sent to ${name} (${cleanedPhone})`
    );
    if (err.response) {
      console.error("Response data:", err.response.data);
      console.error("Response status:", err.response.status);
    }
  }
}

async function createOrderFromPayment(checkout, payment) {
  if (!checkout) {
    console.log("No checkout token provided. Skipping order creation.");
    return;
  }
  if (!payment || !payment.id) {
    console.log("No payment ID provided. Skipping order creation.");
    return;
  }

  const countryCode =
    checkout.shipping_address?.country_code ||
    checkout.billing_address?.country_code ||
    checkout.country_code ||
    "IN";

  const rawPhone =
    checkout.phone ||
    checkout.shipping_address?.phone ||
    checkout.billing_address?.phone ||
    "";

  const sanitizedPhone = rawPhone.replace(/\D/g, "");

  const dialCode = getDialCode(countryCode);
  const phoneNumberInternationalFormat = dialCode
    ? `${dialCode}${sanitizedPhone}`
    : `+91${sanitizedPhone}`;

  const formattedPhone =
    sanitizedPhone.length === 10
      ? `${phoneNumberInternationalFormat}`
      : `+${sanitizedPhone}`;

  let customerId = null;

  try {
    let res = await client.get({
      path: "customers/search",
      query: { phone: `${formattedPhone}` },
    });

    if (res.body.customers?.length > 0) {
      customerId = res.body.customers?.[0]?.id || null;
      console.log("✅ Found customer by phone:", customerId);
    } else if (checkout.email) {
      console.log(
        "ℹ️ No customer found by phone. Trying by email:",
        checkout.email
      );

      res = await client.get({
        path: "customers/search",
        query: { email: `${checkout.email}` },
      });

      if (res.body.customers?.length > 0) {
        customerId = res.body.customers?.[0]?.id || null;
        console.log("✅ Found customer by email:", customerId);
      } else {
        console.log("❌ No existing customer found by phone or email.");
      }
    }
  } catch (error) {
    console.error(
      "Error fetching customer:",
      error.response?.data || error.message
    );
    return;
  }

  let customerData = null;

  if (checkout.customer) {
    customerData = checkout.customer;
  } else if (customerId) {
    customerData = { id: customerId };
  } else {
    customerData = {
      first_name:
        checkout.shipping_address?.first_name ||
        checkout.billing_address?.first_name ||
        "Guest",
      last_name:
        checkout.shipping_address?.last_name ||
        checkout.billing_address?.last_name ||
        "",
      email: checkout.email,
      phone: formattedPhone,
    };
  }

  const includeEmail = !customerId && checkout.email;

  const orderPayload = {
    order: {
      ...(includeEmail && { email: checkout.email }),
      phone:
        checkout.phone ||
        checkout.shipping_address?.phone ||
        checkout.billing_address?.phone ||
        undefined,

      currency: checkout.currency || "INR",

      customer: customerData,

      billing_address: {
        first_name: checkout.billing_address?.first_name || "",
        last_name: checkout.billing_address?.last_name || "",
        address1: checkout.billing_address?.address1 || "",
        address2: checkout.billing_address?.address2 || "",
        city: checkout.billing_address?.city || "",
        province: checkout.billing_address?.province || "",
        country: checkout.billing_address?.country || "",
        zip: checkout.billing_address?.zip || "",
        phone: checkout.billing_address?.phone || "",
      },

      shipping_address: {
        first_name: checkout.shipping_address?.first_name || "",
        last_name: checkout.shipping_address?.last_name || "",
        address1: checkout.shipping_address?.address1 || "",
        address2: checkout.shipping_address?.address2 || "",
        city: checkout.shipping_address?.city || "",
        province: checkout.shipping_address?.province || "",
        country: checkout.shipping_address?.country || "",
        zip: checkout.shipping_address?.zip || "",
        phone: checkout.shipping_address?.phone || "",
      },

      line_items: (checkout.line_items || []).map((item) => ({
        variant_id: item.variant_id,
        quantity: item.quantity || 1,
        title: item.title || undefined,
        price: parseFloat(item.price || 0).toFixed(2),
      })),

      shipping_lines: [
        {
          title: checkout?.shipping_lines[0]?.title || "Standard",
          price: parseFloat(
            checkout.shipping_lines[0]?.price ||
              checkout?.shipping_lines[0]?.original_shop_price ||
              0
          ).toFixed(2),
          code: checkout.shipping_lines[0]?.code || "Standard",
          source: "shopify",
        },
      ],

      tax_lines: (checkout.tax_lines || []).map((t) => ({
        price: parseFloat(t.price || 0).toFixed(2),
        rate: t.rate,
        title: t.title,
      })),

      total_tax: parseFloat(checkout.total_tax || 0).toFixed(2),
      total_discounts: parseFloat(checkout.total_discounts || 0).toFixed(2),

      financial_status: "paid",

      transactions: [
        {
          kind: "sale",
          status: "success",
          amount: parseFloat(checkout.total_price || 0).toFixed(2),
          gateway: "razorpay",
          authorization: payment.id,
        },
      ],

      note: `Auto-created after Razorpay capture (${payment.id}) | cart_token: ${checkout.cart_token} | checkout_token: ${checkout.token}`,
      tags: "ManualOrder, RazorpayPaid",
    },
  };

  try {
    const orderResponse = await client.post({
      path: "orders",
      data: orderPayload,
      type: "application/json",
    });

    console.log(
      "✅ Order created from abandoned checkout:",
      orderResponse.body.order.id
    );

    try {
      const locationRes = await client.get({ path: "locations" });
      const locationId = locationRes.body.locations[0].id;
      if (!locationId) {
        console.error("No location ID found. Cannot adjust inventory.");
        return;
      }

      const headers = {
        headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
      };

      orderResponse.body.order.line_items.forEach(async (item) => {
        const deductionQuantity = item.quantity || 1;
        const variantId = item?.variant_id || 0;
        if (!variantId) {
          console.log("No variant ID found for item:", item);
          return;
        }
        try {
          const variantRes = await axios.get(
            `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/variants/${variantId}.json`,
            headers
          );

          if (!variantRes.data || !variantRes.data.variant) {
            console.log(`No variant found for ID ${variantId}`);
            return;
          }

          console.log(
            `Processing variant ${variantId} for inventory adjustment`
          );
          if (!variantRes.data.variant.inventory_item_id) {
            console.log(`Variant ${variantId} has no inventory item ID`);
            return;
          }

          const inventoryItemId = variantRes.data.variant.inventory_item_id;
          if (!inventoryItemId) {
            console.log("No inventory item ID found for variant:", variantId);
            return;
          }
          console.log(
            `Adjusting inventory for variant ${variantId} (item ID: ${inventoryItemId})`
          );

          try {
            if (orderResponse) {
              const inventoryResponse = await client.post({
                path: `inventory_levels/adjust`,
                data: {
                  location_id: locationId,
                  inventory_item_id: inventoryItemId,
                  available_adjustment: -deductionQuantity,
                },
                type: "application/json",
              });
              if (!inventoryResponse) {
                console.error(
                  `Failed to adjust inventory for variant ${variantId}:`,
                  inventoryResponse
                );
              }
            }
          } catch (inventoryError) {
            console.error(`Error adjusting inventory for variant ${variantId}`);
            if (inventoryError.response) {
              console.error("Response data:", inventoryError.response.data);
              console.error("Response status:", inventoryError.response.status);
            }
          }
        } catch (error) {
          console.error(`Error adjusting inventory for variant ${variantId}`);
          if (error.response) {
            console.error("Response data:", error.response.data);
            console.error("Response status:", error.response.status);
          }
        }
      });
    } catch (error) {
      console.error("❌ Error creating order from checkout");
      if (error.response) {
        console.error("Response data:", error.response.data);
        console.error("Response status:", error.response.status);
      }
    }
  } catch (locationError) {
    console.error("Failed to fetch locations: ", locationError);
    return;
  }
}

async function verifyCheckout(checkout) {
  if (!checkout) {
    console.log("No checkout token provided. Skipping payment fetch.");
    return;
  }

  if (!razorpayClient) {
    console.log("Razorpay client not initialized. Skipping payment fetch.");
    return;
  }

  if (
    !checkout?.email &&
    !checkout?.phone &&
    !checkout?.shipping_address?.phone
  ) {
    console.log("Skipping incomplete checkout (missing contact info)");
    return;
  }

  let orders = [];
  try {
    const phone = checkout?.shipping_address?.phone || checkout?.phone;
    const email = checkout.email;
    const res = await client.get({
      path: "orders",
      query: {
        status: "any",
        limit: 50,
      },
    });
    orders = res.body.orders;

    if (orders) {
      const isOrderNotAbandoned = orders.find(
        (o) => o.cart_token === checkout.cart_token
      );
      if (isOrderNotAbandoned) {
        orderId = isOrderNotAbandoned.id;
        console.log(
          `Checkout ${checkout.cart_token} is not abandoned. Skipping payment verification.`
        );
        return; // Change
      } else {
        console.log(
          `Checkout ${checkout.cart_token} is abandoned. Proceeding with payment verification.`
        );
      }

      const isConverted = orders.find(
        (o) => o.checkout_token === checkout.token
      );
      if (isConverted) {
        console.log(
          `Checkout ${checkout.token} already converted to order. Skipping payment verification.`
        );
        return; // Change
      }

      if (orders?.length) {
        const matchingOrder = orders.find((o) => {
          const orderPhones = [
            o.phone,
            o?.customer?.phone,
            o?.customer?.default_address?.phone,
            o?.shipping_address?.phone,
          ].filter(Boolean);

          const phoneMatches =
            phone && orderPhones.some((p) => p.includes(phone));

          const priceMatches =
            Number(o.total_price) === Number(checkout.total_price);

          return phoneMatches && priceMatches;
        });

        if (matchingOrder) {
          console.log(
            `Duplicate order detected for phone ${phone} with total_price ${checkout.total_price}. Order ID: ${matchingOrder.id}`
          );
          return;
        }

        console.log(
          `Checkout ${checkout.cart_token} seems abandoned. Proceeding with payment verification.`
        );
      }

      if (orders?.length) {
        const matchingOrder = orders.find((o) => {
          const orderEmails = [o?.email, o?.customer?.email].filter(Boolean);

          const emailMatches = email && orderEmails.some((e) => e === email);

          const priceMatches =
            Number(o.total_price) === Number(checkout.total_price);

          return emailMatches && priceMatches;
        });

        if (matchingOrder) {
          console.log(
            `Duplicate order detected for email ${email} with total_price ${checkout.total_price}. Order ID: ${matchingOrder.id}`
          );
          return;
        }

        console.log(
          `Checkout ${checkout.cart_token} seems abandoned. Proceeding with payment verification.`
        );
      }
    }
  } catch (err) {
    console.error("Failed to fetch orders:", err.response.data);
  }

  try {
    const processedPayments = loadSet(dataFiles.payments, "set");

    const todaysPayments = await razorpayClient.fetchTodaysPayments();
    if (!todaysPayments || !todaysPayments.items) {
      console.log("No payments found for today.");
    } else {
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const twoHoursAgo = currentTimestamp - MINUTES_FOR_PAYMENT_CHECK * 60;
      const totalCheckoutPrice = Number(checkout.total_price);

      const matchingPayments = todaysPayments.items
        .filter((payment) => {
          if (payment.status !== "captured") return false;
          if (!payment?.notes?.cancelUrl) return false;

          const perfectPhoneDigits = payment?.contact
            .replace(/\s+/g, "")
            .slice(-10);
          const perfectAmount = payment.amount / 100;

          const matchesPhoneAndAmount =
            (perfectPhoneDigits === checkout?.shipping_address?.phone &&
              perfectAmount === totalCheckoutPrice) ||
            (payment.contact === checkout?.phone &&
              perfectAmount === totalCheckoutPrice);

          const matchesCartToken = payment.notes.cancelUrl.includes(
            checkout?.cart_token
          );

          const isWithinTimeRange =
            payment.created_at >= twoHoursAgo &&
            payment.created_at <= currentTimestamp;

          return (
            (matchesPhoneAndAmount || matchesCartToken) && isWithinTimeRange
          );
        })
        .sort((a, b) => b.created_at - a.created_at);

      const capturedPayment = matchingPayments[0];

      if (!capturedPayment) {
        console.log(
          `No captured payments found for checkout ${checkout.cart_token}. Proceeding with message queueing.`
        );
        messageQueue.push({ checkout });
        processQueue();
        return;
      }

      if (processingPayments.has(capturedPayment.id)) {
        console.log(
          `⚠️ Payment ${capturedPayment.id} is being processed. Skipping.`
        );
        return;
      }

      if (!lockId(capturedPayment.id)) {
        console.log(`Payment ${capturedPayment.id} is locked persistently.`);
        return;
      }

      processingPayments.add(capturedPayment.id);

      try {
        if (processedPayments.has(capturedPayment.id)) {
          console.log(
            `Payment ${capturedPayment.id} already processed. Skipping.`
          );
          return;
        }

        console.log(
          `Captured payment found for checkout ${checkout.cart_token}:`,
          capturedPayment.contact,
          capturedPayment.id,
          new Date(capturedPayment.created_at * 1000).toLocaleString()
        );

        await createOrderFromPayment(checkout, capturedPayment);
        saveSet(dataFiles.payments, processedPayments, capturedPayment.id);
      } finally {
        processingPayments.delete(capturedPayment.id);
        unlockId(capturedPayment.id);
      }
    }
  } catch (error) {
    console.error("Error fetching payments");
  }
}

setInterval(() => {
  const checkouts = loadSet(dataFiles.checkouts, "debounced");
  const now = Date.now();

  if (Object.keys(checkouts).length === 0) return;

  let changed = false;

  for (const [cart_token, data] of Object.entries(checkouts)) {
    const timeSinceUpdate = now - data.updatedAt;

    if (timeSinceUpdate >= SEND_MESSAGE_DELAY) {
      const checkout = data.checkout;

      const shipping = checkout.shipping_address || {};
      const email = checkout.email || "";
      const rawPhone = shipping?.phone || checkout.phone || "";
      const hasValidPhone = rawPhone.replace(/\D/g, "").length >= 10;

      const hasContactInfo = hasValidPhone || email;

      if (hasContactInfo) {
        console.log(`Processing cart_token: ${cart_token}`);
        verifyCheckout(checkout);
      } else {
        console.log(`Still missing info for: ${cart_token}`);
      }

      delete checkouts[cart_token];
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(dataFiles.checkouts, JSON.stringify(checkouts, null, 2));
  }
}, CHECK_INTERVAL);

app.post("/webhook/abandoned-checkouts", async (req, res) => {
  res.status(200).send("OK");

  const checkout = req.body;
  const cart_token = checkout?.cart_token;

  if (!cart_token) return;

  const checkouts = loadSet(dataFiles.checkouts, "debounced");

  saveSet(
    dataFiles.checkouts,
    checkouts,
    { cart_token, checkout },
    "debounced"
  );
});

// --- Order Confirmation ---
// const restockInventoryFromOrder = async (orderId) => {
//   try {
//     // 1. Fetch the order to get line_items
//     const orderRes = await client.get({
//       path: `orders/${orderId}.json`,
//     });
//     const order = orderRes.body.order;
//     const lineItems = order.line_items;

//     const locationRes = await client.get({ path: "locations" });
//     const locationId = locationRes.body.locations[0].id;
//     if (!locationId) {
//       console.error("No location ID found. Cannot adjust inventory.");
//       return;
//     }

//     const headers = {
//       headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
//     };

//     if (!lineItems.length) {
//       console.log("No line items found to restock.");
//       return;
//     }

//     // 3. Loop through each item and restock
//     for (const item of lineItems) {
//       const variantId = item.variant_id;
//       const quantityToRestock = item.quantity;

//       // Get inventory_item_id for the variant
//       const variantRes = await axios.get(
//         `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/variants/${variantId}.json`,
//         headers
//       );

//       if (!variantRes.data || !variantRes.data.variant) {
//         console.log(`No variant found for ID ${variantId}`);
//         return;
//       }

//       console.log(`Processing variant ${variantId} for inventory adjustment`);
//       if (!variantRes.data.variant.inventory_item_id) {
//         console.log(`Variant ${variantId} has no inventory item ID`);
//         return;
//       }

//       const inventoryItemId = variantRes.data.variant.inventory_item_id;
//       if (!inventoryItemId) {
//         console.log("No inventory item ID found for variant:", variantId);
//         return;
//       }
//       console.log(
//         `Adjusting inventory for variant ${variantId} (item ID: ${inventoryItemId})`
//       );
//       // Restock the inventory
//       const inventoryResponse = await client.post({
//         path: `inventory_levels/adjust.json`,
//         data: {
//           location_id: locationId,
//           inventory_item_id: inventoryItemId,
//           available_adjustment: quantityToRestock,
//         },
//         type: "application/json",
//       });

//       console.log(
//         `Restocked ${quantityToRestock} units for variant ${variantId}`
//       );
//     }

//     console.log(`✅ Inventory restocked successfully for order ${orderId}`);
//   } catch (error) {
//     console.error(
//       "❌ Error restocking inventory:",
//       error.response?.data || error.message
//     );
//   }
// };

// const cancelOrder = async (orderId) => {
//   try {
//     restockInventoryFromOrder(orderId).then(async () => {
//       const cancelResponse = await client.post({
//         path: `orders/${orderId}/cancel.json`,
//         data: {
//           email: false,
//         },
//         type: "application/json",
//       });

//       console.log(`✅ Order ${orderId} cancelled successfully`);
//       return cancelResponse.body;
//     });
//   } catch (error) {
//     console.error(
//       "❌ Error cancelling order:",
//       error.response?.data || error.message
//     );
//   }
// };

// async function processOrder(order) {
//   const phone =
//     order?.phone ||
//     order.billing_address?.phone ||
//     order.customer.default_address?.phone;
//   const queryField = order.email || order.customer?.email ? "email" : "phone";
//   const queryValue = order.email || phone;

//   const res = await client.get({
//     path: "orders",
//     query: {
//       [queryField]: queryValue,
//       fields: "id, note",
//       status: "any",
//       limit: 50,
//     },
//   });
//   const orders = res.body.orders;
//   if (orders || orders.length > 0) {
//     const matchingOrder = orders.find(
//       (o) => o.note && o.note.indexOf(order.checkout_token) !== -1
//     );
//     if (matchingOrder) {
//       cancelOrder(order.id);
//       return;
//     }
//   }
// }

const processedOrders = loadSet(dataFiles.orders, "set");

async function sendOrderConfirmation(order) {
  try {
    const customer = order.customer || {};
    const shippingAddress = order.shipping_address || {};
    const name =
      shippingAddress.first_name || customer.first_name || "Customer";
    const orderName = order.name.replace("#", "") || "Unknown Order";
    const amount = order.total_price || "0";

    const countryCode =
      order.shipping_address?.country_code ||
      order.billing_address?.country_code ||
      "IN";

    const dialCode = getDialCode(countryCode);

    let rawPhone = shippingAddress.phone || customer.phone || "";
    let cleanedPhone = rawPhone.replace(/\s+/g, "").slice(-10);
    const phoneNumberInternationalFormat = dialCode + cleanedPhone;

    let imageUrl =
      "https://cdn.shopify.com/s/files/1/0655/1352/1302/files/WhatsApp_Image_2025-05-21_at_21.13.58.jpg";
    if (order.line_items?.length) {
      const productId = order.line_items[0].product_id;
      const variantId = order.line_items[0].variant_id;
      const headers = {
        headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
      };

      try {
        const productImagesRes = await axios.get(
          `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/products/${productId}/images.json`,
          headers
        );
        if (productImagesRes?.data?.images?.length) {
          const variantImage = productImagesRes?.data?.images.find((img) =>
            img.variant_ids.includes(variantId)
          );
          imageUrl = (
            variantImage || productImagesRes?.data?.images[0]
          ).src.split("?")[0];
        }
      } catch (imageError) {
        console.error("Failed to fetch product image");
      }
    }

    let orderStatusURL = `${process.env.SHOP_URL}/account/order/${order.id}`;
    if (order.order_status_url) {
      orderStatusURL = (() => {
        try {
          const url = new URL(order.order_status_url);
          return url.pathname.replace(/^\//, "");
        } catch {
          return order.order_status_url;
        }
      })();
    }

    const payload = {
      apiKey: process.env.AISENSY_API_KEY,
      campaignName: process.env.OC_CAMPAIGN_NAME,
      destination: phoneNumberInternationalFormat,
      userName: name,
      source: "organic",
      templateParams: [name, orderName, `₹${amount}`, orderStatusURL],
      media: {
        url: imageUrl,
        filename: "order.jpg",
      },
      buttons: [
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: orderStatusURL }],
        },
      ],
    };

    try {
      const response = await axios.post(
        "https://backend.aisensy.com/campaign/t1/api/v2",
        payload
      );
      saveSet(dataFiles.orders, processedOrders, order.id.toString(), "set");
      console.log(`Order confirmation message sent for ${order.cart_token}`);
      console.log(`Order confirmation sent to ${name} (${cleanedPhone})`);
    } catch (err) {
      console.error("Order confirmation message error");
      console.log(`Order confirmation cannot be sent to (${cleanedPhone})`);
      if (err.response) {
        console.error("Response data:", err.response.data);
        console.error("Response status:", err.response.status);
      }
    }
  } catch (err) {
    console.error("Order confirmation error");
  }
}

async function sendLowStockNotification(order) {
  const orderId = order.id;
  try {
    // 1. Fetch the order to get line_items
    const orderRes = await client.get({
      path: `orders/${orderId}.json`,
    });

    const order = orderRes.body.order;
    const lineItems = order.line_items;

    const locationRes = await client.get({ path: "locations" });

    const locationId = locationRes.body.locations[0].id;
    if (!locationId) {
      console.error("No location ID found. Cannot adjust inventory.");
      return;
    }

    const headers = {
      headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
    };

    if (!lineItems.length) {
      console.log("No line items found to restock.");
      return;
    }

    // 3. Loop through each item and restock
    for (const item of lineItems) {
      const productId = item.product_id;
      const variantId = item.variant_id;

      // Get inventory_item_id for the variant
      const productRes = await axios.get(
        `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/products/${productId}.json`,
        headers
      );

      // Get inventory_item_id for the variant
      const variantRes = await axios.get(
        `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/variants/${variantId}.json`,
        headers
      );

      if (!variantRes.data || !variantRes.data.variant) {
        console.log(`No variant found for ID ${variantId}`);
        return;
      }

      const productTitle = productRes.data.product.title;
      let productCode = productRes.data.product.body_html || "";
      const $ = cheerio.load(productCode);
      productCode = $("p").text().trim() || "No code available";

      const productOption = variantRes.data.variant.option1;
      const currentStock = variantRes.data.variant.inventory_quantity;

      const thresholdQuantity = 4; // Set your low stock threshold
      let imageUrl =
        "https://cdn.shopify.com/s/files/1/0655/1352/1302/files/WhatsApp_Image_2025-05-21_at_21.13.58.jpg";

      try {
        const productImagesRes = await axios.get(
          `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/products/${productId}/images.json`,
          headers
        );

        if (productImagesRes?.data?.images?.length > 0) {
          const variantImage = productImagesRes?.data?.images.find((img) =>
            img.variant_ids.includes(variantId)
          );
          imageUrl = (
            variantImage || productImagesRes?.data?.images[0]
          ).src.split("?")[0];
        }
      } catch (imageError) {
        console.error("Failed to fetch product image");
      }
      const viewInventoryUrl = `admin/products/${productId}?variant=${variantId}`;

      if (currentStock < thresholdQuantity) {
        const payload = {
          apiKey: process.env.AISENSY_API_KEY,
          campaignName: process.env.LSA_CAMPAIGN_NAME,
          destination: "+917715878352",
          // destination: "+919309950513",
          userName: "Admin",
          source: "low_stock",
          templateParams: [
            productTitle.toString(),
            productCode.toString(),
            productOption.toString() || "Default Variant",
            currentStock.toString(),
            thresholdQuantity.toString(),
            viewInventoryUrl.toString(),
          ],
          media: {
            url: imageUrl,
            filename: "product.jpg",
          },
          buttons: [
            {
              type: "button",
              sub_type: "url",
              index: "0",
              parameters: [{ type: "text", text: viewInventoryUrl }],
            },
          ],
        };

        try {
          const response = await axios.post(
            "https://backend.aisensy.com/campaign/t1/api/v2",
            payload
          );
          console.log(
            `Low stock alert sent for ${productTitle} (${productOption})`
          );
        } catch (err) {
          console.error("Low stock alert message error");
          if (err.response) {
            console.error("Response data: ", err.response.data);
            console.error("Response status: ", err.response.status);
          }
        }
      }
    }
  } catch (error) {
    console.error(
      "❌ Error sending low stock alert: ",
      error.response?.data || error.message
    );
  }
}

app.post("/webhook/order-confirmation", (req, res) => {
  res.status(200).send("Order confirmation webhook received");
  const order = req.body;

  if (processedOrders.has(order.id.toString())) {
    console.log(`Order ${order.id} already processed`);
    return;
  }

  // processOrder(order);
  sendLowStockNotification(order);
  sendOrderConfirmation(order);
});

// --- Fulfillment Creation ---
const processedFulfillments = loadSet(dataFiles.fulfillments, "set");

async function sendFulfillmentMessage(fulfillment) {
  try {
    const orderId = fulfillment.order_id;
    const customer = fulfillment.destination || {};
    const name = customer.first_name || "Customer";
    const orderName =
      fulfillment.name.replace("#", "").split(".")[0] || "Unknown Order";
    const trackingNumber = fulfillment.tracking_number || "Unknown fulfillment";
    try {
      const order = await client.get({
        path: `orders/${orderId}`,
      });
      amount = order.body.order.total_price || "0";
    } catch (orderError) {
      console.error("Failed to fetch order details:", orderError);
    } finally {
      console.log(`Processing fulfillment for order ${orderName} (${orderId})`);
    }

    const countryCode = fulfillment.destination?.country_code || "IN"; // Default to India if not found

    const dialCode = getDialCode(countryCode);

    let rawPhone = customer.phone || "";
    let cleanedPhone = rawPhone.replace(/\s+/g, "").slice(-10);
    const phoneNumberInternationalFormat = dialCode + cleanedPhone;

    const fulfillmentStatusURL = fulfillment.tracking_url;

    // Product image
    let imageUrl =
      "https://cdn.shopify.com/s/files/1/0655/1352/1302/files/WhatsApp_Image_2025-05-21_at_21.13.58.jpg";
    if (fulfillment.line_items?.length > 0) {
      const productId = fulfillment.line_items[0].product_id;
      const variantId = fulfillment.line_items[0].variant_id;
      const headers = {
        headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
      };

      try {
        const productImagesRes = await axios.get(
          `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/products/${productId}/images.json`,
          headers
        );
        if (productImagesRes?.data?.images?.length > 0) {
          const variantImage = productImagesRes?.data?.images.find((img) =>
            img.variant_ids.includes(variantId)
          );
          imageUrl = (
            variantImage || productImagesRes?.data?.images[0]
          ).src.split("?")[0];
        }
      } catch (imageError) {
        console.error("Failed to fetch product image:", imageError);
      }
    }

    const payload = {
      apiKey: process.env.AISENSY_API_KEY,
      campaignName: process.env.OST_CAMPAIGN_NAME,
      destination: phoneNumberInternationalFormat,
      userName: name,
      source: "fulfillment",
      templateParams: [
        `${name}`,
        `${orderName}`,
        `${trackingNumber}`,
        `${fulfillmentStatusURL}`,
      ],
      media: {
        url: imageUrl,
        filename: "product.jpg",
      },
      buttons: [
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [
            {
              type: "text",
              text: `${fulfillmentStatusURL}`,
            },
          ],
        },
      ],
    };

    try {
      const response = await axios.post(
        "https://backend.aisensy.com/campaign/t1/api/v2",
        payload
      );
      saveSet(
        dataFiles.fulfillments,
        processedFulfillments,
        fulfillment.id.toString(),
        "set"
      );
      console.log("Fulfillment message sent:", response.data);
      console.log(`Fulfillment message sent to ${name} (${cleanedPhone})`);
    } catch (err) {
      console.error("Fulfillment message error");
      console.log(`Fulfillment message cannot be sent`);
      if (err.response) {
        console.error("Response data:", err.response.data);
        console.error("Response status:", err.response.status);
      }
    }
  } catch (err) {
    console.error("Fulfillment message error");
  }
}

app.post("/webhook/fulfillment-creation", (req, res) => {
  res.status(200).send("OK");
  const fulfillment = req.body;

  if (processedFulfillments.has(fulfillment.id.toString())) {
    console.log(`Fulfillment ${fulfillment.id} already processed`);
    return;
  }

  sendFulfillmentMessage(fulfillment);
});

// --- Redirect Service ---
app.get("/redirect_for_shipment", (req, res) => {
  const target = req.query.link;

  if (!target || typeof target !== "string") {
    return res.status(400).send("Missing or invalid 'link' parameter.");
  }

  return res.redirect(target);
});

// --- 1️⃣ CORS Middleware for Order Tracking ---
function corsForOrderTracking(req, res, next) {
  const origin = req.headers.origin;

  // Allow Shopify domains
  const SHOPIFY_FRONTEND_ORIGINS = [
    "https://bsseje-4d.myshopify.com",
    "https://de5ebb-74.myshopify.com",
    "https://www.kaushalyaartjewellery.com",
  ];

  // ✅ If the origin is allowed, apply dynamic CORS headers
  if (SHOPIFY_FRONTEND_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return next();
  }

  // ✅ Allow direct browser (no-origin) calls, e.g., testing
  if (!origin) return next();

  // ❌ Deny all other origins but return JSON instead of HTML
  res.status(403).json({ error: "CORS blocked. Unauthorized origin.", origin });
}

app.get("/order-tracking", corsForOrderTracking, async (req, res) => {
  try {
    const { order, order_id, name, phone } = req.query;

    // --- UTIL HELPERS ---
    const clean = (v) =>
      v ? v.toString().trim().toLowerCase() : "";

    const digits = (v) =>
      v ? v.toString().replace(/[^0-9]/g, "") : "";

    const last10 = (v) => digits(v).slice(-10);

    async function getFulfillment(orderId) {
      try {
        const fulRes = await client.get({
          path: `orders/${orderId}/fulfillments`,
        });
        const list = fulRes.body?.fulfillments || [];
        return list.length ? list[list.length - 1] : null;
      } catch (err) {
        return null;
      }
    }

    function formatTracking(ful) {
      return ful
        ? {
            tracking_number: ful.tracking_number || "Not Available",
            tracking_url: ful.tracking_url || null,
            courier: ful.tracking_company || "Not Specified",
            status: ful.shipment_status || "pending",
            estimated_delivery: ful.estimated_delivery_at || null,
          }
        : {
            tracking_number: "Not Available",
            tracking_url: null,
            courier: "Not Specified",
            status: "pending",
            estimated_delivery: null,
          };
    }

    // ============================================================
    // ⭐ NAME + PHONE SEARCH (supports multiple orders)
    // ============================================================
    if (name && phone) {
      const phone10 = last10(phone);
      const nameClean = clean(name);

      // Fetch many orders
      const resp = await client.get({
        path: "orders",
        query: {
          status: "any",
          limit: 250,
        },
      });

      const orders = resp.body.orders || [];

      // Try matching phone from many fields
      const phoneMatches = orders.filter((o) => {
        const p1 = last10(o?.billing_address?.phone);
        const p2 = last10(o?.shipping_address?.phone);
        const p3 = last10(o?.customer?.phone);
        const p4 = last10(o?.customer?.default_address?.phone);

        return [p1, p2, p3, p4].includes(phone10);
      });

      if (!phoneMatches.length) {
        return res.json({ orders: [] }); // Always return empty instead of error
      }

      // try matching by name
      const strongMatches = phoneMatches.filter((o) => {
        const full = clean(
          `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`
        );
        return full.includes(nameClean);
      });

      const finalList = strongMatches.length ? strongMatches : phoneMatches;

      // attach tracking (fulfilled or not)
      const results = [];
      for (const o of finalList) {
        const ful = await getFulfillment(o.id);
        results.push({
          id: o.id,
          name: o.name,
          tracking: formatTracking(ful),
        });
      }

      return res.json({ orders: results });
    }

    // ============================================================
    // ⭐ ORDER NUMBER SEARCH (single order)
    // ============================================================
    if (!order && !order_id) {
      return res.json({ orders: [] });
    }

    let finalOrderId = order_id;

    if (order) {
      const resp = await client.get({
        path: "orders",
        query: {
          name: `#${order.replace("#", "")}`,
          status: "any",
          limit: 1,
        },
      });

      const found = resp.body.orders?.[0];
      if (!found) return res.json({ orders: [] });

      finalOrderId = found.id;
    }

    const ful = await getFulfillment(finalOrderId);

    return res.json({
      orders: [
        {
          id: finalOrderId,
          name: `#${order || finalOrderId}`,
          tracking: formatTracking(ful),
        },
      ],
    });
  } catch (err) {
    console.error(err);
    return res.json({ orders: [] });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Shopify webhook server running on port ${PORT}`);
});
