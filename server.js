// server.js  (ESM version for Render)

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import twilio from "twilio";

const app = express();
const PORT = process.env.PORT || 10000;

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VERIFY_SID = process.env.TWILIO_VERIFY_SID;

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN env vars");
}
if (!VERIFY_SID) {
  console.error("Missing TWILIO_VERIFY_SID env var");
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

app.use(cors());
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "phone-validator" });
});

// Helper: normalize to 10-digit US + E.164
function normalizePhone(rawInput) {
  const digits = (rawInput || "").toString().replace(/\D/g, "");
  if (digits.length !== 10) {
    return { error: "bad-length" };
  }

  const local = digits.slice(3); // last 7 digits

  // Reject super-obvious fake patterns
  if (/0000$/.test(local) || /^(\d)\1{6,}$/.test(local)) {
    return { error: "fake-pattern" };
  }

  return {
    e164: `+1${digits}`,
    digits
  };
}

/**
 * POST /validate-phone
 * Body: { phone: "string" }
 * Uses Twilio Lookup v2 (line_type_intelligence) to decide if this is a
 * plausible, reachable US number. Used for real-time gating and UI.
 */
app.post("/validate-phone", async (req, res) => {
  try {
    const norm = normalizePhone(req.body.phone);

    if (norm.error === "bad-length") {
      return res.json({
        valid: false,
        type: "bad-length",
        message: "Please enter a 10-digit US phone number."
      });
    }

    if (norm.error === "fake-pattern") {
      return res.json({
        valid: false,
        type: "fake-pattern",
        message: "Please enter a real, reachable mobile or landline number."
      });
    }

    const { e164 } = norm;

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
      // Accept MOBILE, LANDLINE, VOIP, UNKNOWN as long as:
      // - passes our pattern checks
      // - Twilio is NOT explicitly saying "UNREACHABLE"
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
 * POST /start-verify
 * Body: { phone: "string" }
 * After validate-phone passes, this sends an OTP via SMS using Twilio Verify.
 */
app.post("/start-verify", async (req, res) => {
  try {
    const norm = normalizePhone(req.body.phone);

    if (norm.error) {
      return res.json({
        ok: false,
        reason: norm.error,
        message: "Please enter a valid 10-digit US phone number."
      });
    }

    const { e164 } = norm;

    const verification = await client.verify.v2
      .services(VERIFY_SID)
      .verifications.create({
        to: e164,
        channel: "sms"
      });

    console.log("Started verification", {
      to: e164,
      sid: verification.sid,
      status: verification.status
    });

    return res.json({
      ok: true,
      status: verification.status,
      message: "Verification code sent via SMS."
    });
  } catch (err) {
    console.error("Error starting verification:", err);
    return res.status(500).json({
      ok: false,
      message: "Could not send verification code."
    });
  }
});

/**
 * POST /check-verify
 * Body: { phone: "string", code: "string" }
 * Checks the OTP code. If status === "approved", we consider the phone verified.
 */
app.post("/check-verify", async (req, res) => {
  try {
    const norm = normalizePhone(req.body.phone);
    const code = (req.body.code || "").toString().trim();

    if (norm.error || !code) {
      return res.json({
        ok: false,
        status: "invalid",
        message: "Phone or code is missing or invalid."
      });
    }

    const { e164 } = norm;

    const check = await client.verify.v2
      .services(VERIFY_SID)
      .verificationChecks.create({
        to: e164,
        code
      });

    console.log("Verification check", {
      to: e164,
      sid: check.sid,
      status: check.status
    });

    const approved = check.status === "approved";

    return res.json({
      ok: approved,
      status: check.status,
      message: approved
        ? "Phone verified."
        : "The code you entered is incorrect or expired."
    });
  } catch (err) {
    console.error("Error checking verification:", err);
    return res.status(500).json({
      ok: false,
      status: "error",
      message: "Error verifying code."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Phone validation API listening on port ${PORT}`);
});
