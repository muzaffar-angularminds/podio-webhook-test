/**
 * Static app registry.
 * Each entry represents a Podio app to sync.
 * extractFields: only these fields are stored in transformedFields (flat key:value).
 * All fields are always stored in rawFields regardless.
 */
module.exports = [
  {
    appId: 13038875,
    name: "Call Backs",
    token: "3f6d5749c42948d6b3a4521793a31455",
    extractFields: [
      "status-dont-touch",
      "datetime-called-in",
      "campaign",
      "icp-score",
      "call-back-assigned-to",
      "ppl-refund-status",
    ],
  },
  {
    appId: 10934018,
    name: "Seller Leads",
    token: "90ad63b4372a42f0b933f887e48916ab",
    extractFields: [
      "icp-score",
      "related-name",
      "person-who-answered-the-phone",
      "set-an-appointment-3",
      "scheduled-appt-item",
      "related-mailer-campaign",
      "related-mailer-design",
      "leadid",
    ],
  },
  {
    appId: 10975143,
    name: "Appointments",
    token: "6a8ead8bf8aa4638b7db4f25a867dbdd",
    extractFields: ["meeting-date", "appointment-type", "meeting-location"],
  },
  {
    appId: 10936061,
    name: "TC",
    token: "7b6206ab806d4a9ca849543d57a538ba",
    extractFields: [
      "status-dont-touch",
      "exit",
      "market",
      "purchase-price",
      "final-sales-price",
      "net-profit",
      "campaign-2",
      "contract-reference-date",
      "final-settlement-date",
      "am",
    ],
  },
  {
    appId: 13030443,
    name: "Incoming Calls",
    token: "bcdca022b6654c6d9101500bc4bea779",
    extractFields: [
      "call-datetime",
      "call-type",
      "campaign",
      "duration",
      "agent-answered",
      "talk-time-ratio",
    ],
  },
];
