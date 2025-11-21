import express from "express";
import cors from "cors";
import twilio from "twilio";

const app = express();
const PORT = process.env.PORT || 3000;

// Use env vars on your host (Render, Vercel, etc.)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
// or for API keys:
// const apiKey = process.env.TWILIO_API_KEY;
// const apiSecret = process.env.TWILIO_API_SECRET;

if (!accountSid || !authToken) {
  console.error("Missing Twilio credentials in env vars.");
  process.exit(1);
}

const client = twilio(accountSid, authToken);
// const client = twilio(apiKey, apiSecret, { accountSid });

app.use(cors());
app.use(express.json());

app.post("/validate-phone", async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({
      valid: false,
      message: "Please enter your phone number.",
    });
  }

  try {
    const lookup = await client.lookups.v2
      .phoneNumbers(phone)
      .fetch({ type: ["carrier"] });

    const isMobile =
      lookup.carrier &&
      (lookup.carrier.type === "mobile" ||
        lookup.carrier.type === "voip" ||
        lookup.carrier.type === "voicemail");

    return res.json({
      valid: true,
      e164: lookup.phoneNumber,
      isMobile,
      countryCode: lookup.countryCode,
    });
  } catch (err) {
    console.error("Twilio lookup error:", err.message);
    return res.json({
      valid: false,
      message: "Please enter a valid phone number.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Phone validation API listening on port ${PORT}`);
});
