// server.js  (ESM version – works with "type": "module" in package.json)
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import twilio from "twilio";

const app = express();
const PORT = process.env.PORT || 10000;

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN env vars");
}

if (!VERIFY_SERVICE_SID) {
  console.warn("TWILIO_VERIFY_SERVICE_SID is not set – Verify endpoints will fail.");
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

app.use(cors());
app.use(bodyParser.json());

// Simple health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "phone-validator" });
});

/**
 * /validate-phone
 * - What you already had working with Lookup v2
 * - Used by Unbounce for “is this a sane US number?”
 */
app.post("/validate-phone", async (req, res) => {
  try {
    const raw = (req.body.phone || "").toString().replace(/\D/g, "");

    // Basic US length check
    if (raw.length !== 10) {
      return res.json({
        valid: false,
        type: "bad-length",
        message: "Please enter a 10-digit US phone number."
      });
    }

    // Basic pattern filters for obvious junk
    const local = raw.slice(3); // last 7 digits

    // 0000 at the end or all same digit like 8888888
    if (/0000$/.test(local) || /^(\d)\1{6,}$/.test(local)) {
      return res.json({
        valid: false,
        type: "fake-pattern",
        message: "Please enter a real, reachable mobile or landline number."
      });
    }

    const e164 = "+1" + raw;

    // Twilio Lookup v2 with line type intelligence
    const lookup = await client.lookups.v2
      .phoneNumbers(e164)
      .fetch({ fields: "line_type_intelligence" });

    const countryCode = lookup.countryCode || null;
    const lti = lookup.lineTypeIntelligence || {};

    const lineType = (lti.lineType || "").toLowerCase() || "unknown";
    const reachability = (lti.reachability || "").toUpperCase() || "UNKNOWN";

    console.log("Twilio lookup", {
      e164,
      countryCode,
      lineType,
      reachability
    });

    // --- VALIDITY RULES ---

    let valid = false;
    let reason = "unknown";

    // Must be US
    if (countryCode !== "US") {
      valid = false;
      reason = "non-us";
    } else if (reachability === "UNREACHABLE") {
      // Twilio explicitly says it's unreachable
      valid = false;
      reason = "unreachable";
    } else {
      // Accept MOBILE, LANDLINE, VOIP as long as not unreachable
      valid = true;
      reason = "ok";
    }

    return res.json({
      valid,
      type: lineType || "unknown",
      countryCode,
      reachability,
      reason,
      message: valid
        ? "Valid US phone."
        : "Please enter a real, reachable mobile or landline number."
    });
  } catch (err) {
    console.error("Error validating phone:", err);
    return res.status(500).json({
      valid: false,
      type: "error",
      message: "Could not validate phone number."
    });
  }
});

/**
 * /start-verify
 * - Starts an OTP via Twilio Verify (SMS)
 * - This WILL send an SMS, so only call it when the user expects a code
 */
app.post("/start-verify", async (req, res) => {
  try {
    if (!VERIFY_SERVICE_SID) {
      return res.status(500).json({
        success: false,
        message: "Verify service not configured on server."
      });
    }

    const raw = (req.body.phone || "").toString().replace(/\D/g, "");
    if (raw.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "Please enter a 10-digit US phone number."
      });
    }

    const to = "+1" + raw;

    const verification = await client.verify.v2
      .services(VERIFY_SERVICE_SID)
      .verifications.create({
        to,
        channel: "sms"
      });

    console.log("Verify start:", {
      to,
      sid: verification.sid,
      status: verification.status
    });

    return res.json({
      success: true,
      status: verification.status
    });
  } catch (err) {
    console.error("Error starting verification:", err);
    return res.status(500).json({
      success: false,
      message: "Could not start phone verification."
    });
  }
});

/**
 * /check-verify
 * - Confirms the OTP the user typed in
 * - Returns valid: true if the code is approved
 */
app.post("/check-verify", async (req, res) => {
  try {
    if (!VERIFY_SERVICE_SID) {
      return res.status(500).json({
        success: false,
        message: "Verify service not configured on server."
      });
    }

    const raw = (req.body.phone || "").toString().replace(/\D/g, "");
    const code = (req.body.code || "").toString().trim();

    if (raw.length !== 10 || !code) {
      return res.status(400).json({
        success: false,
        message: "Phone and code are required."
      });
    }

    const to = "+1" + raw;

    const check = await client.verify.v2
      .services(VERIFY_SERVICE_SID)
      .verificationChecks.create({
        to,
        code
      });

    console.log("Verify check:", {
      to,
      sid: check.sid,
      status: check.status
    });

    const approved = check.status === "approved";

    return res.json({
      success: true,
      valid: approved,
      status: check.status
    });
  } catch (err) {
    console.error("Error checking verification:", err);
    return res.status(500).json({
      success: false,
      message: "Could not check verification code."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Phone validation API listening on port ${PORT}`);
});
