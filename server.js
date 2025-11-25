// server.js
const express = require("express");
const cors = require("cors");
const twilio = require("twilio");

const app = express();
const PORT = process.env.PORT || 10000;

// Twilio credentials MUST be set as env vars in Render
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error("⚠️ Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "phone-validator" });
});

app.post("/validate-phone", async (req, res) => {
  try {
    const raw = (req.body.phone || "").toString().replace(/\D/g, "");

    // Require 10-digit US number
    if (raw.length !== 10) {
      return res.json({
        valid: false,
        reason: "bad-length",
        message: "Enter a 10-digit US phone number."
      });
    }

    const local = raw.slice(3); // last 7 digits

    // Obvious fake patterns:
    // - ends in 0000
    // - all 7 local digits the same (e.g. 8888888)
    if (/0000$/.test(local) || /^(\d)\1{6}$/.test(local)) {
      return res.json({
        valid: false,
        reason: "fake-pattern",
        message: "Please enter a real, reachable mobile or landline number."
      });
    }

    const e164 = "+1" + raw;

    // Lookup v2 with line type + line status
    const lookup = await client.lookups.v2
      .phoneNumbers(e164)
      .fetch({
        // make sure these are enabled in Twilio for your account
        fields: "line_type_intelligence,line_status"
      });

    const countryCode   = lookup.countryCode || null;
    const isValidFormat = lookup.valid === true;

    const lti = lookup.lineTypeIntelligence || {};
    const lineType = (lti.type || "unknown").toLowerCase(); // mobile, landline, fixedvoip, nonfixedvoip, etc.

    const ls = lookup.lineStatus || {};
    const lineStatus = ls.status || null; // e.g. "Active", "Reachable", "Unreachable", "Inactive", "Unknown"

    console.log("Twilio lookup:", {
      e164,
      countryCode,
      valid: isValidFormat,
      lineType,
      lineStatus
    });

    let valid  = false;
    let reason = "unknown";

    // 1) Must be a valid US number
    if (!isValidFormat) {
      valid = false;
      reason = "format";
    } else if (countryCode !== "US") {
      valid = false;
      reason = "non-us";
    } else {
      // 2) VOIP vs non-VOIP handling
      const isVoip =
        lineType === "fixedvoip" ||
        lineType === "nonfixedvoip" ||
        lineType === "voip";

      if (isVoip) {
        // You requested: accept VOIP only if it's "active"
        const activeStatuses = ["Active", "Reachable"];
        if (lineStatus && activeStatuses.includes(lineStatus)) {
          valid = true;
          reason = "voip-active";
        } else {
          valid = false;
          reason = "voip-not-active";
        }
      } else {
        // For non-VOIP: accept as long as format + country are OK
        valid = true;
        reason = "ok";
      }
    }

    return res.json({
      valid,
      reason,
      type: lineType || "unknown",
      countryCode,
      lineStatus,
      message: valid
        ? "Valid US phone."
        : "Please enter a real, reachable US mobile or landline number."
    });
  } catch (err) {
    console.error("Error validating phone:", err);
    return res.status(500).json({
      valid: false,
      reason: "error",
      message: "Could not validate phone number."
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Phone validation API listening on port ${PORT}`);
});
