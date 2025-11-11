const Razorpay = require("razorpay");

const { RAZORPAY_API_KEY, RAZORPAY_API_SECRET } = process.env;

if (!RAZORPAY_API_KEY || !RAZORPAY_API_SECRET) {
  throw new Error("Missing Razorpay credentials");
}

// Create Razorpay instance (like shopifyApi())
const razorpay = new Razorpay({
  key_id: RAZORPAY_API_KEY,
  key_secret: RAZORPAY_API_SECRET,
});

// Optional: Wrap in a custom client for consistency
class RazorpayClient {
  constructor(instance) {
    this.instance = instance;
  }

  async fetchPayment(paymentId) {
    return await this.instance.payments.fetch(paymentId);
  }

  async fetchAllPayments(params = {}) {
    return await this.instance.payments.all(params);
  }

  async capturePayment(paymentId, amount) {
    return await this.instance.payments.capture(paymentId, amount);
  }

  async fetchLastPayments(limit = 5) {
    return await this.instance.payments.all({ count: limit });
  }

  async fetchTodaysPayments() {
    const now = new Date();
    // Set start of day (00:00:00) and end of current time
    const from = Math.floor(
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() /
        1000
    ); // start of today
    const to = Math.floor(now.getTime() / 1000); // current time

    return await this.instance.payments.all({ from, to, count: 100 });
  }

  async fetchYesterdaysPayments() {
    const now = new Date();

    // Get yesterday's date
    const yesterday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1
    );

    // Start of yesterday (00:00:00)
    const from = Math.floor(yesterday.getTime() / 1000);

    // End of yesterday (23:59:59)
    const endOfYesterday = new Date(
      yesterday.getFullYear(),
      yesterday.getMonth(),
      yesterday.getDate(),
      23,
      59,
      59
    );
    const to = Math.floor(endOfYesterday.getTime() / 1000);

    return await this.instance.payments.all({ from, to, count: 100 });
  }

  // Add more wrappers as needed
}

const razorpayClient = new RazorpayClient(razorpay);
module.exports = { razorpayClient };
