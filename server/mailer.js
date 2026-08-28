import nodemailer from "nodemailer";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const testMode = process.env.NODE_ENV === "test";
const uniqueEmails = (recipients) => [...new Set((recipients || []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
const transporterFor = ({ email, appPassword }) => nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: email, pass: appPassword } });

const send = async ({ sender, recipients, subject, text, html }) => {
  const uniqueRecipients = uniqueEmails(recipients);
  if (!uniqueRecipients.length) return { status: "NO_RECIPIENTS", sent: 0, failed: 0 };
  if (!sender?.email || !sender?.appPassword) return { status: "NOT_CONFIGURED", sent: 0, failed: uniqueRecipients.length };
  if (testMode) return { status: "SENT", sent: uniqueRecipients.length, failed: 0 };
  const transporter = transporterFor(sender);
  const settled = await Promise.allSettled(uniqueRecipients.map((to) => transporter.sendMail({ from: `DockFlow <${sender.email}>`, to, subject, text, html })));
  const sent = settled.filter((result) => result.status === "fulfilled").length;
  return { status: sent === uniqueRecipients.length ? "SENT" : sent ? "PARTIAL" : "FAILED", sent, failed: uniqueRecipients.length - sent };
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
