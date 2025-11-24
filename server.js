// server.js
import express from "express";
import cors from "cors";
import twilio from "twilio";

const app = express();
const PORT = process.env.PORT || 10000;

// env vars in Render: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "phone-validator" });
});

// Simple pattern filter for obviously fake numbers
function looksFakeLocal(local) {
  // 0000 at the end or all digits the same like 8888888, 9999999, etc.
  if (/0000$/.test(local)) return true;
  if (/^(\d)\1{6,}$/.test(local)) return true;
  return false;
}

app.post("/validate-phone", async (req, res) => {
  try {
    let raw = (req.body.phone || "").toString();
    // strip non-digits
    raw = raw.replace(/\D/g, "");

    if (raw.length !== 10) {
      return res.json({
        valid: false,
        type: "unknown",
        message: "Please enter a 10-digit US phone number."
      });
    }

    const area = raw.slice(0, 3);
    const local = raw.slice(3);

    // block obviously fake patterns like 000-0000, 999-9999, etc
    if (looksFakeLocal(local)) {
      return res.json({
        valid: false,
        type: "fake-pattern",
        message: "Please enter a real, reachable mobile or landline number."
      });
    }

    const e164 = "+1" + raw;

    // Ask Twilio with line_type_intelligence
    const lookup = await client.lookups.v2
      .phoneNumbers(e164)
      .fetch({ fields: "line_type_intelligence" });

    // Twilio fields
    const countryCode = lookup.countryCode || null;
    const lti = lookup.lineTypeIntelligence || {};
    const lineType = (lti.lineType || "").toLowerCase() || "unknown";
    const reachability = (lti.reachability || "").toUpperCase() || "UNKNOWN";

    // Our rules:
    const isUS = countryCode === "US";
    const isGoodType = ["mobile", "landline", "fixed_line", "fixed_line_or_mobile"].includes(
      lineType
    );
    const isReachable = reachability === "REACHABLE";

    const valid = isUS && isGoodType && isReachable;

    if (!valid) {
      return res.json({
        valid: false,
        e164,
        type: lineType || "unknown",
        countryCode,
        reachability,
        message: "Please enter a real, reachable US mobile or landline number."
      });
    }

    // Passed all checks
    return res.json({
      valid: true,
      e164,
      type: lineType,
      countryCode,
      reachability
    });
  } catch (err) {
    console.error("Phone validation error:", err?.message || err);
    return res.status(500).json({
      valid: false,
      type: "error",
      message: "We could not verify your phone number. Please try again."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Phone validation API listening on port ${PORT}`);
});
