// server.js  (ESM - requires "type": "module" in package.json)
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import twilio from "twilio";

const app = express();
const PORT = process.env.PORT || 10000;

// --- ENV VARS ---
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN env vars");
}
if (!VERIFY_SERVICE_SID) {
  console.error("Missing TWILIO_VERIFY_SERVICE_SID env var");
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

app.use(cors());
app.use(bodyParser.json());

// Simple healthcheck
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "phone-validator + verify" });
});

// Helper: normalize to US E.164 and basic pattern checks
function normalizeAndBasicCheck(rawPhone) {
  const digits = (rawPhone || "").toString().replace(/\D/g, "");

  if (digits.length !== 10) {
    return {
      ok: false,
      error: {
        valid: false,
        type: "bad-length",
        message: "Please enter a 10-digit US phone number."
      }
    };
  }

  const local = digits.slice(3); // last 7 digits

  // Obvious junk: ends in 0000 or all same digit (e.g., 8888888)
  if (/0000$/.test(local) || /^(\d)\1{6,}$/.test(local)) {
    return {
      ok: false,
      error: {
        valid: false,
        type: "fake-pattern",
        message: "Please enter a real, reachable mobile or landline number."
      }
    };
  }

  return {
    ok: true,
    digits,
    e164: "+1" + digits
  };
}

/**
 * 1) LOOKUP-BASED VALIDATION
 *    POST /validate-phone
 *    Body: { phone: "7141231234" or "(714) 123-1234" }
 *    Response: { valid, type, countryCode, reachability, reason, message }
 */
app.post("/validate-phone", async (req, res) => {
  try {
    const norm = normalizeAndBasicCheck(req.body.phone);

    if (!norm.ok) {
      return res.json(norm.error);
    }

    const { e164, digits } = norm; // digits kept if you want it later

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

    let valid = false;
    let reason = "unknown";

    if (countryCode !== "US") {
      valid = false;
      reason = "non-us";
    } else if (reachability === "UNREACHABLE") {
      valid = false;
      reason = "unreachable";
    } else {
      // Accept MOBILE, LANDLINE, VOIP as long as they are not unreachable.
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
    console.error("Error validating phone via Lookup:", err);
    return res.status(500).json({
      valid: false,
      type: "error",
      message: "Could not validate phone number."
    });
  }
});

/**
 * 2) START VERIFY (send OTP via SMS)
 *    POST /start-verify
 *    Body: { phone: "7141231234" }
 *    Response: { sent: true, status, to }
 *
 *    This is what will start showing up in Twilio "Verify logs".
 */
app.post("/start-verify", async (req, res) => {
  try {
    const norm = normalizeAndBasicCheck(req.body.phone);
    if (!norm.ok) {
      // Return same structure as /validate-phone error
      return res.json(norm.error);
    }

    const { e164 } = norm;

    if (!VERIFY_SERVICE_SID) {
      return res.status(500).json({
        sent: false,
        message: "Verify Service SID not configured on server."
      });
    }

    // OPTIONAL: quick lookup gate before sending OTP
    const lookup = await client.lookups.v2
      .phoneNumbers(e164)
      .fetch({ fields: "line_type_intelligence" });

    const countryCode = lookup.countryCode || null;
    const lti = lookup.lineTypeIntelligence || {};
    const reachability = (lti.reachability || "").toUpperCase() || "UNKNOWN";

    if (countryCode !== "US") {
      return res.json({
        sent: false,
        reason: "non-us",
        message: "Please enter a US phone number."
      });
    }

    if (reachability === "UNREACHABLE") {
      return res.json({
        sent: false,
        reason: "unreachable",
        message: "This number appears unreachable. Please use a different phone."
      });
    }

    // Send verification code via SMS
    const verification = await client.verify.v2
      .services(VERIFY_SERVICE_SID)
      .verifications.create({
        to: e164,
        channel: "sms"
      });

    console.log("Twilio Verify sent", {
      to: e164,
      sid: verification.sid,
      status: verification.status
    });

    return res.json({
      sent: true,
      to: e164,
      status: verification.status // usually "pending"
    });
  } catch (err) {
    console.error("Error starting Verify:", err);
    return res.status(500).json({
      sent: false,
      message: "Could not start verification."
    });
  }
});

/**
 * 3) CHECK VERIFY (confirm OTP)
 *    POST /check-verify
 *    Body: { phone: "7141231234", code: "123456" }
 *    Response: { valid: true/false, status, message }
 */
app.post("/check-verify", async (req, res) => {
  try {
    const norm = normalizeAndBasicCheck(req.body.phone);
    if (!norm.ok) {
      return res.json({
        valid: false,
        message: norm.error.message || "Invalid phone number format."
      });
    }

    const { e164 } = norm;
    const code = (req.body.code || "").toString().trim();

    if (!code) {
      return res.json({
        valid: false,
        message: "Verification code is required."
      });
    }

    if (!VERIFY_SERVICE_SID) {
      return res.status(500).json({
        valid: false,
        message: "Verify Service SID not configured on server."
      });
    }

    const check = await client.verify.v2
      .services(VERIFY_SERVICE_SID)
      .verificationChecks.create({
        to: e164,
        code
      });

    console.log("Twilio Verify check", {
      to: e164,
      sid: check.sid,
      status: check.status
    });

    const isApproved = check.status === "approved";

    return res.json({
      valid: isApproved,
      status: check.status,
      message: isApproved
        ? "Phone number successfully verified."
        : "The verification code you entered is invalid or expired."
    });
  } catch (err) {
    console.error("Error checking Verify code:", err);
    return res.status(500).json({
      valid: false,
      message: "Could not check verification code."
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Phone validation API + Verify listening on port ${PORT}`);
});
