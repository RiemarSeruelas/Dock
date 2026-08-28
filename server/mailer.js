import nodemailer from "nodemailer";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const testMode = process.env.NODE_ENV === "test";
const uniqueEmails = (recipients) => [...new Set((recipients || []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
const transporterFor = ({ email, appPassword, host = "smtp.gmail.com", port = 465, secure = true }) => nodemailer.createTransport({ host, port, secure, auth: { user: email, pass: appPassword } });
const safeFailureMessage = (error) => {
  const code = String(error?.code || "").toUpperCase();
  const responseCode = Number(error?.responseCode || 0);
  if (code === "EAUTH" || responseCode === 534 || responseCode === 535) return "Gmail rejected the administrator sender. Check SMTP_USER and use a Google App Password in SMTP_APP_PASSWORD.";
  if (["ETIMEDOUT", "ESOCKET", "ECONNECTION", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EDNS"].includes(code)) return "DockFlow could not reach Gmail from the API container. Check internet access, DNS, firewall rules, and smtp.gmail.com port 465.";
  if ([550, 551, 552, 553, 554].includes(responseCode)) return "The mail server rejected the sender or recipient address. Confirm that both addresses are real email accounts.";
  return "The mail server rejected the verification message. Check the API container logs for the SMTP error code.";
};

const send = async ({ sender, recipients, subject, text, html }) => {
  const uniqueRecipients = uniqueEmails(recipients);
  if (!uniqueRecipients.length) return { status: "NO_RECIPIENTS", sent: 0, failed: 0 };
  if (!sender?.email || !sender?.appPassword) return { status: "NOT_CONFIGURED", sent: 0, failed: uniqueRecipients.length };
  if (testMode) return { status: "SENT", sent: uniqueRecipients.length, failed: 0 };
  const transporter = transporterFor(sender);
  const settled = await Promise.allSettled(uniqueRecipients.map((to) => transporter.sendMail({ from: sender.from || `DockFlow <${sender.email}>`, to, subject, text, html })));
  const sent = settled.filter((result) => result.status === "fulfilled").length;
  const firstFailure = settled.find((result) => result.status === "rejected");
  return { status: sent === uniqueRecipients.length ? "SENT" : sent ? "PARTIAL" : "FAILED", sent, failed: uniqueRecipients.length - sent, ...(firstFailure ? { message: safeFailureMessage(firstFailure.reason), errorCode: String(firstFailure.reason?.code || firstFailure.reason?.responseCode || "SMTP_ERROR") } : {}) };
};

export const emailNotifications = {
  async verifySender(sender) {
    if (testMode) return true;
    await transporterFor(sender).verify();
    return true;
  },
  async sendVerificationCode({ sender, recipient, code }) {
    return send({ sender, recipients: [recipient], subject: "Verify your DockFlow email", text: `Your DockFlow verification code is ${code}. It expires in 10 minutes.`, html: `<p>Your DockFlow verification code is:</p><p style="font-size:28px;font-weight:800;letter-spacing:6px">${escapeHtml(code)}</p><p>It expires in 10 minutes.</p>` });
  },
  async sendNewSds({ sender, recipients, fileName, proposalCount }) {
    return send({ sender, recipients, subject: "New SDS schedule ready in DockFlow", text: `A new SDS file (${fileName}) was uploaded with ${proposalCount} proposed delivery schedule${proposalCount === 1 ? "" : "s"}. Sign in to DockFlow to confirm or reject the proposed delivery.`, html: `<p>A new SDS file <strong>${escapeHtml(fileName)}</strong> was uploaded with <strong>${proposalCount}</strong> proposed delivery schedule${proposalCount === 1 ? "" : "s"}.</p><p>Sign in to DockFlow to confirm or reject the proposed delivery.</p>` });
  },
  async sendSupplierDecision({ sender, recipients, shipmentNumber, supplier, decision, reason, alternativeDate, alternativeTime }) {
    const rejected = decision === "REJECTED";
    return send({ sender, recipients, subject: `${supplier} ${rejected ? "rejected" : "confirmed"} ${shipmentNumber}`, text: `${supplier} ${rejected ? "rejected" : "confirmed"} delivery ${shipmentNumber}.${rejected ? ` Reason: ${reason}. Proposed alternative: ${alternativeDate} at ${alternativeTime}.` : ""}`, html: `<p><strong>${escapeHtml(supplier)}</strong> ${rejected ? "rejected" : "confirmed"} delivery <strong>${escapeHtml(shipmentNumber)}</strong>.</p>${rejected ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p><p><strong>Proposed alternative:</strong> ${escapeHtml(alternativeDate)} at ${escapeHtml(alternativeTime)}</p>` : ""}` });
  },
};
