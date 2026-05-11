require("dotenv").config();

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");

const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
  if (req.originalUrl === "/webhooks/stripe") return next();
  express.json({ limit: "2mb" })(req, res, next);
});
app.use(cors());
app.use(express.urlencoded({ extended: true }));

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}
function boolEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return ["true", "1", "yes", "y"].includes(String(value).toLowerCase());
}
function getConfig() {
  const moveInTotalCents = Number(process.env.MOVE_IN_TOTAL_CENTS || 100000);
  return {
    businessName: process.env.BUSINESS_NAME || "Mike Archer Sober Living",
    ownerName: process.env.OWNER_NAME || "Mike Archer",
    ownerEmail: process.env.OWNER_EMAIL || "",
    ownerPhone: process.env.OWNER_PHONE || "",
    roomAvailable: boolEnv("ROOM_AVAILABLE", true),
    roomCount: Number(process.env.ROOM_COUNT || 1),
    rentAmount: process.env.RENT_AMOUNT || "500",
    depositAmount: process.env.DEPOSIT_AMOUNT || "500",
    moveInTotalCents,
    moveInTotalDisplay: money(moveInTotalCents),
    calendlyUrl: process.env.CALENDLY_URL || process.env.CALCOM_URL || "",
    docusignPowerformUrl: process.env.DOCUSIGN_POWERFORM_URL || "",
    publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${port}`
  };
}
function args(req) {
  const body = req.body || {};
  if (body.args && typeof body.args === "object") return body.args;
  if (body.arguments && typeof body.arguments === "object") return body.arguments;
  if (body.parameters && typeof body.parameters === "object") return body.parameters;
  return body;
}
function retell(data) {
  return { result: data.message || "Done.", ...data };
}
function emailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}
async function sendEmail({ to, subject, text }) {
  if (!emailConfigured()) {
    console.log("[EMAIL NOT CONFIGURED]", { to, subject, text });
    return { sent: false };
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({ from: process.env.EMAIL_FROM || process.env.SMTP_USER, to, subject, text });
  return { sent: true };
}

app.get("/", (req, res) => {
  const c = getConfig();
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>${c.businessName}</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{margin:0;font-family:Arial,sans-serif;background:#080808;color:#fff}.wrap{max-width:900px;margin:0 auto;padding:48px 22px}.card{border:1px solid #2a2a2a;border-radius:22px;padding:30px;background:linear-gradient(145deg,#111,#191919)}h1{font-size:clamp(34px,5vw,58px);margin:0 0 12px}.price{font-size:28px;color:#34d399;font-weight:bold;margin:16px 0}.buttons{display:flex;flex-wrap:wrap;gap:14px;margin-top:24px}a.button{padding:14px 18px;border-radius:14px;text-decoration:none;background:#10b981;color:#03120d;font-weight:bold}a.secondary{background:#27272a;color:#fff;border:1px solid #3f3f46}.rule{background:#121212;border:1px solid #27272a;padding:10px 12px;border-radius:12px;margin:8px 0}</style></head><body><main class="wrap"><section class="card">
<h1>${c.businessName}</h1><p>Retell AI phone intake demo for sober living room availability, rules, payment, booking, and agreement signing.</p>
<div class="price">$${c.rentAmount} rent + $${c.depositAmount} deposit = ${c.moveInTotalDisplay}</div>
<p><strong>Room availability:</strong> ${c.roomAvailable ? `${c.roomCount} room(s) available.` : "No rooms available. Waitlist only."}</p>
<div class="buttons"><a class="button" href="/pay">Pay With Stripe</a><a class="button secondary" href="/book">Book Appointment</a><a class="button secondary" href="/contract">Sign Agreement</a><a class="button secondary" href="/status">Status</a></div>
<div style="margin-top:22px"><div class="rule">Must stay sober.</div><div class="rule">Must attend meetings.</div><div class="rule">Must attend weekly house meeting.</div><div class="rule">No drugs, alcohol, stealing, fighting, threats, or disrespect.</div></div>
</section></main></body></html>`);
});
app.get("/status", (req, res) => {
  const c = getConfig();
  res.json({ ok: true, service: "Retell sober living demo", roomAvailable: c.roomAvailable, roomCount: c.roomCount, stripeConfigured: !!process.env.STRIPE_SECRET_KEY, bookingConfigured: !!c.calendlyUrl, docusignConfigured: !!c.docusignPowerformUrl, emailConfigured: emailConfigured() });
});
app.get("/book", (req, res) => {
  const c = getConfig();
  if (!c.calendlyUrl) return res.status(500).send("Booking URL not configured. Add CALENDLY_URL or CALCOM_URL in Railway variables.");
  res.redirect(c.calendlyUrl);
});
app.get("/contract", (req, res) => {
  const c = getConfig();
  if (!c.docusignPowerformUrl) return res.status(500).send("DocuSign PowerForm URL not configured.");
  res.redirect(c.docusignPowerformUrl);
});
app.get("/success", (req, res) => res.send("<h1>Payment received.</h1><p>Your payment was completed successfully.</p>"));
app.get("/cancel", (req, res) => res.send("<h1>Payment canceled.</h1><p>No payment was completed.</p>"));
app.get("/pay", async (req, res) => {
  try {
    const c = getConfig();
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).send("STRIPE_SECRET_KEY missing in Railway variables.");
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: process.env.STRIPE_SUCCESS_URL || `${c.publicBaseUrl}/success`,
      cancel_url: process.env.STRIPE_CANCEL_URL || `${c.publicBaseUrl}/cancel`,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: c.moveInTotalCents, product_data: { name: `${c.businessName} move-in payment`, description: `$${c.rentAmount} rent + $${c.depositAmount} deposit` } } }]
    });
    res.redirect(session.url);
  } catch (err) { console.error(err); res.status(500).send(err.message); }
});
app.post("/api/retell/check-room-availability", (req, res) => {
  const c = getConfig();
  if (!c.roomAvailable || c.roomCount < 1) return res.json(retell({ available: false, message: "There are no rooms available right now. I can collect your name, phone, and email for the waitlist." }));
  res.json(retell({ available: true, roomCount: c.roomCount, moveInTotal: c.moveInTotalDisplay, message: `Yes, there ${c.roomCount === 1 ? "is" : "are"} ${c.roomCount} room${c.roomCount === 1 ? "" : "s"} available. The move-in cost is ${c.moveInTotalDisplay}: $${c.rentAmount} rent plus a $${c.depositAmount} deposit.` }));
});
app.post("/api/retell/get-rules", (req, res) => {
  res.json(retell({ rules: ["Must stay sober.","Must attend recovery meetings.","Must attend the weekly house meeting.","No drugs.","No alcohol.","No stealing.","No fighting.","No threats.","No disrespect toward the house or other residents.","Breaking these rules can result in removal from the house."], message: "The basic house rules are: you must stay sober, attend recovery meetings, attend the weekly house meeting, no drugs, no alcohol, no stealing, no fighting, no threats, and no disrespect toward the house or other residents. Breaking these rules can result in removal from the house." }));
});
app.post("/api/retell/create-stripe-checkout", async (req, res) => {
  const c = getConfig();
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json(retell({ error: "STRIPE_SECRET_KEY missing", message: "Stripe is not configured yet." }));
  const a = args(req);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: a.customer_email || a.email || undefined,
    success_url: process.env.STRIPE_SUCCESS_URL || `${c.publicBaseUrl}/success`,
    cancel_url: process.env.STRIPE_CANCEL_URL || `${c.publicBaseUrl}/cancel`,
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: c.moveInTotalCents, product_data: { name: `${c.businessName} move-in payment`, description: `$${c.rentAmount} rent + $${c.depositAmount} deposit` } } }],
    metadata: { customer_name: a.customer_name || a.name || "", payment_reason: "sober_living_move_in" }
  });
  res.json(retell({ checkout_url: session.url, session_id: session.id, message: `I created the secure Stripe payment link: ${session.url}` }));
});
app.post("/api/retell/get-next-step-links", (req, res) => {
  const c = getConfig();
  res.json(retell({ payment_url: `${c.publicBaseUrl}/pay`, booking_url: `${c.publicBaseUrl}/book`, contract_url: `${c.publicBaseUrl}/contract`, message: `The payment link is ${c.publicBaseUrl}/pay. The booking link is ${c.publicBaseUrl}/book. The agreement link is ${c.publicBaseUrl}/contract.` }));
});
app.post("/api/retell/send-links", async (req, res) => {
  const c = getConfig();
  const a = args(req);
  const customerEmail = a.customer_email || a.email;
  const customerName = a.customer_name || a.name || "there";
  if (!customerEmail) return res.status(400).json(retell({ message: "I need the customer's email before I can send the links." }));
  const paymentUrl = `${c.publicBaseUrl}/pay`, bookingUrl = `${c.publicBaseUrl}/book`, contractUrl = `${c.publicBaseUrl}/contract`;
  const text = `Hi ${customerName},\n\nHere are your next steps for ${c.businessName}:\n\nPay move-in total:\n${paymentUrl}\n\nBook appointment:\n${bookingUrl}\n\nSign agreement:\n${contractUrl}\n\nMove-in total: ${c.moveInTotalDisplay}\n`;
  const emailResult = await sendEmail({ to: customerEmail, subject: `${c.businessName}: next steps`, text });
  res.json(retell({ sent: emailResult.sent, payment_url: paymentUrl, booking_url: bookingUrl, contract_url: contractUrl, message: emailResult.sent ? `I sent the payment, booking, and agreement links to ${customerEmail}.` : `Email is not configured yet, but the payment link is ${paymentUrl}, the booking link is ${bookingUrl}, and the agreement link is ${contractUrl}.` }));
});
app.post("/api/retell/send-owner-summary", async (req, res) => {
  const c = getConfig(), a = args(req);
  const summary = { name: a.customer_name || a.name || "", phone: a.customer_phone || a.phone || "", email: a.customer_email || a.email || "", sober_status: a.sober_status || "", move_in_timeframe: a.move_in_timeframe || "", agreed_to_rules: a.agreed_to_rules || "", notes: a.notes || a.summary || "" };
  console.log("[OWNER SUMMARY]", summary);
  if (!c.ownerEmail) return res.json(retell({ sent: false, summary, message: "Owner email is not configured, but the summary was logged." }));
  const text = `New sober living intake lead\n\nName: ${summary.name}\nPhone: ${summary.phone}\nEmail: ${summary.email}\nSober status: ${summary.sober_status}\nMove-in timeframe: ${summary.move_in_timeframe}\nAgreed to rules: ${summary.agreed_to_rules}\nNotes: ${summary.notes}\n`;
  const emailResult = await sendEmail({ to: c.ownerEmail, subject: `New intake lead: ${summary.name || "Caller"}`, text });
  res.json(retell({ sent: emailResult.sent, summary, message: emailResult.sent ? `I sent the intake summary to ${c.ownerEmail}.` : "Summary logged. Email is not configured yet." }));
});
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { console.error("[STRIPE WEBHOOK ERROR]", err.message); return res.status(400).send(`Webhook Error: ${err.message}`); }
  if (event.type === "checkout.session.completed") console.log("[PAYMENT COMPLETE]", event.data.object);
  res.json({ received: true });
});
app.listen(port, () => console.log(`Retell sober living demo running on port ${port}`));
