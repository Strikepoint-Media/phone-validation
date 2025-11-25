// server.js  (ESM)
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import twilio from "twilio";

const app = express();
const PORT = process.env.PORT || 10000;

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VERIFY_SID = process.env.TWILIO_VERIFY_SID; // matches your Render env

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN env vars");
}
if (!VERIFY_SID) {
  console.warn("TWILIO_VERIFY_SID is not set - Verify endpoints will fail.");
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

app.use(cors());
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "phone-validator + verify" });
});

/**
 * Helper: normalise to +1E164 and do a basic US length check
 */
function normalizeUsPhone(raw) {
  const digits = (raw || "").toString().replace(/\D/g, "");
  if (digits.length !== 10) {
    return null;
  }
  return "+1" + digits;
}

/**
 * Optional: quick Lookup validation (no OTP)
 * POST /validate-phone { phone }
 */
app.post("/validate-phone", async (req, res) => {
  try {
    const e164 = normalizeUsPhone(req.body.phone);
    if (!e164) {
      return res.json({
        valid: false,
        type: "bad-length",
        message: "Please enter a 10-digit US phone number."
      });
    }

    // basic fake pattern filter
    const local = e164.slice(3); // last 7 digits
    if (/0000$/.test(local) || /^(\d)\1{6,}$/.test(local)) {
      return res.json({
        valid: false,
        type: "fake-pattern",
        message: "Please enter a real, reachable mobile or landline number."
      });
    }

    const lookup = await client.lookups.v2
      .phoneNumbers(e164)
      .fetch({ fields: "line_type_intelligence" });

    const countryCode = lookup.countryCode || null;
    const lti = lookup.lineTypeIntelligence || {};
    const lineType = (lti.lineType || "").toLowerCase() || "unknown";
    const reachability = (lti.reachability || "").toUpperCase() || "UNKNOWN";

    console.log("Lookup:", { e164, countryCode, lineType, reachability });

    let valid = false;
    let reason = "unknown";

    if (countryCode !== "US") {
      valid = false;
      reason = "non-us";
    } else if (reachability === "UNREACHABLE") {
      valid = false;
      reason = "unreachable";
    } else {
      valid = true;
      reason = "ok";
    }

    return res.json({
      valid,
      type: lineType,
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
 * START VERIFY - send OTP
 * POST /start-verify { phone }
 */
app.post("/start-verify", async (req, res) => {
  try {
    if (!VERIFY_SID) {
      return res.status(500).json({
        ok: false,
        message: "Verify service not configured on the server."
      });
    }

    const e164 = normalizeUsPhone(req.body.phone);
    if (!e164) {
      return res.json({
        ok: false,
        message: "Please enter a 10-digit US phone number."
      });
    }

    const verification = await client.verify.v2
      .services(VERIFY_SID)
      .verifications.create({
        to: e164,
        channel: "sms"
      });

    console.log("Start verify:", { to: e164, sid: verification.sid, status: verification.status });

    return res.json({
      ok: true,
      status: verification.status // pending
    });
  } catch (err) {
    console.error("Error starting verify:", err);
    return res.status(500).json({
      ok: false,
      message: "Could not start phone verification."
    });
  }
});

/**
 * CHECK VERIFY - confirm OTP
 * POST /check-verify { phone, code }
 */
app.post("/check-verify", async (req, res) => {
  try {
    if (!VERIFY_SID) {
      return res.status(500).json({
        ok: false,
        message: "Verify service not configured on the server."
      });
    }

    const e164 = normalizeUsPhone(req.body.phone);
    const code = (req.body.code || "").toString().trim();

    if (!e164 || !code) {
      return res.json({
        ok: false,
        message: "Missing phone or verification code."
      });
    }

    const check = await client.verify.v2
      .services(VERIFY_SID)
      .verificationChecks.create({
        to: e164,
        code
      });

    console.log("Check verify:", {
      to: e164,
      status: check.status,
      valid: check.valid
    });

    const success = check.status === "approved" || check.valid === true;

    return res.json({
      ok: success,
      status: check.status,
      valid: !!check.valid
    });
  } catch (err) {
    console.error("Error checking verify:", err);
    return res.status(500).json({
      ok: false,
      message: "Could not check verification code."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Phone validation API listening on port ${PORT}`);
});
