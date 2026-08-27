import nodemailer from "nodemailer";

const enabled = String(process.env.EMAIL_NOTIFICATIONS_ENABLED || "false").toLowerCase() === "true";
const host = String(process.env.SMTP_HOST || "smtp.gmail.com");
const port = Number(process.env.SMTP_PORT || 465);
const secure = String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";
const user = String(process.env.SMTP_USER || "");
const password = String(process.env.SMTP_APP_PASSWORD || "");
const from = String(process.env.MAIL_FROM || user || "DockFlow");

let transporter;

const getTransporter = () => {
  if (!transporter) transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass: password } });
  return transporter;
};

export const emailNotifications = {
  enabled,

  async sendNewSds({ recipients, fileName, proposalCount }) {
    const uniqueRecipients = [...new Set((recipients || []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
    if (!enabled) return { status: "DISABLED", sent: 0, failed: 0 };
    if (!user || !password) return { status: "NOT_CONFIGURED", sent: 0, failed: uniqueRecipients.length };
    if (!uniqueRecipients.length) return { status: "NO_RECIPIENTS", sent: 0, failed: 0 };

    const settled = await Promise.allSettled(uniqueRecipients.map((to) => getTransporter().sendMail({
      from,
      to,
      subject: "New SDS schedule ready in DockFlow",
      text: `A new SDS file (${fileName}) was uploaded with ${proposalCount} proposed delivery schedule${proposalCount === 1 ? "" : "s"}. Sign in to DockFlow to accept the proposed time or submit one alternative time.`,
      html: `<p>A new SDS file <strong>${escapeHtml(fileName)}</strong> was uploaded with <strong>${proposalCount}</strong> proposed delivery schedule${proposalCount === 1 ? "" : "s"}.</p><p>Sign in to DockFlow to accept the proposed time or submit one alternative time.</p>`,
    })));
    const sent = settled.filter((result) => result.status === "fulfilled").length;
    return { status: sent === uniqueRecipients.length ? "SENT" : sent ? "PARTIAL" : "FAILED", sent, failed: uniqueRecipients.length - sent };
  },
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
