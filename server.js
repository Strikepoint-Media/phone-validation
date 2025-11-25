// server.js  (ESM version – works with "type": "module")
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import twilio from "twilio";

const app = express();
const PORT = process.env.PORT || 10000;

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN env vars");
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

app.use(cors());
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "phone-validator" });
});

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

app.listen(PORT, () => {
  console.log(`Phone validation API listening on port ${PORT}`);
});
