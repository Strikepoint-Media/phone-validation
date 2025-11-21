import express from "express";
import cors from "cors";
import twilio from "twilio";

const app = express();

// Use Render's PORT or default to 10000 locally
const PORT = process.env.PORT || 10000;

// Twilio credentials from environment variables
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error("ERROR: Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN env vars.");
  process.exit(1);
}

// Initialize Twilio client
const client = twilio(accountSid, authToken);

// Middleware
app.use(cors());
app.use(express.json());

// Simple health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "phone-validator" });
});

/**
 * POST /validate-phone
 * Body: { "phone": "<raw phone string from form>" }
 *
 * Rules:
 *  - Must be a real, reachable number according to Twilio Lookup
 *  - Allow: mobile, landline
 *  - Block: voip, toll-free, unknown / error
 */
app.post("/validate-phone", async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({
      valid: false,
      message: "Please enter your phone number."
    });
  }

  try {
    // Ask Twilio for carrier info (this tells us the line type)
    const lookup = await client.lookups.v2
      .phoneNumbers(phone)
      .fetch({ type: ["carrier"] });

    const carrier = lookup.carrier || {};
    const carrierType = (carrier.type || "").toLowerCase();
    const e164 = (lookup.phoneNumber || "").toString();

    // Detect toll-free US numbers (800, 888, 877, 866, 855, 844, 833, 822)
    const tollFreeRegex = /^\+?1(800|888|877|866|855|844|833|822)\d{7}$/;
    const isTollFree = tollFreeRegex.test(e164);

    // Define which line types we accept
    const allowedTypes = ["mobile", "landline"];
    const typeOK = allowedTypes.includes(carrierType);

    // Explicit VOIP block
    const isVoip = carrierType === "voip";

    // Final decision
    const ok = typeOK && !isTollFree && !isVoip;

    if (!ok) {
      return res.json({
        valid: false,
        type: carrierType || "unknown",
        message: "Please enter a real, reachable mobile or landline number."
      });
    }

    // Passed all checks
    return res.json({
      valid: true,
      e164,
      type: carrierType,
      countryCode: lookup.countryCode
    });
  } catch (err) {
    console.error("Twilio lookup error:", err.message);

    // If Twilio can't look it up, treat as invalid for safety
    return res.json({
      valid: false,
      message: "This phone number could not be verified. Please check it and try again."
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Phone validation API listening on port ${PORT}`);
});
