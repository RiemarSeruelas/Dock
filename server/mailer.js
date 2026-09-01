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

const scheduleText = (details) => `${details.date} at ${details.time}${details.endTime ? `–${details.endTime}` : ""}`;
const itemText = (details) => (details.items || []).map((item) => `${item.materialCode}: ${item.quantity} ${item.uom}`).join("\n");
const detailText = (label, details) => `${label}\nSchedule: ${scheduleText(details)}\nSite: ${details.site || "Not specified"}\nMaterial codes:\n${itemText(details) || "None"}`;
const detailHtml = (label, details, tone) => `<div style="margin:12px 0;padding:14px;border:1px solid ${tone};border-radius:10px"><strong>${escapeHtml(label)}</strong><p style="margin:8px 0 4px"><b>Schedule:</b> ${escapeHtml(scheduleText(details))}<br><b>Site:</b> ${escapeHtml(details.site || "Not specified")}</p><p style="margin:8px 0 4px"><b>Material codes</b></p><ul style="margin-top:4px">${(details.items || []).map((item) => `<li><b>${escapeHtml(item.materialCode)}</b> — ${escapeHtml(item.quantity)} ${escapeHtml(item.uom)}</li>`).join("") || "<li>None</li>"}</ul></div>`;

export const buildSdsChangeEmail = ({ supplier, changes }) => {
  const subject = `DockFlow delivery changes – ${supplier}`;
  const textBlocks = changes.map((change) => change.kind === "RESCHEDULE"
    ? `Reschedule\nDelivery: ${change.shipmentNumber}\n\n${detailText("Before", change.before)}\n\n${detailText("After", change.after)}`
    : `New proposed delivery\nDelivery: ${change.shipmentNumber}\n\nBefore\nNo previous delivery proposal\n\n${detailText("After", change.after)}`);
  const htmlBlocks = changes.map((change) => `<section style="margin:18px 0;padding-top:4px;border-top:2px solid #e8edf5"><h2 style="font-size:18px">${change.kind === "RESCHEDULE" ? "Reschedule" : "New proposed delivery"}</h2><p><b>Delivery:</b> ${escapeHtml(change.shipmentNumber)}</p>${change.kind === "RESCHEDULE" ? `${detailHtml("Before", change.before, "#f2b8b5")}${detailHtml("After", change.after, "#9fd8ca")}` : `<div style="margin:12px 0;padding:14px;border:1px solid #d8e1ed;border-radius:10px"><strong>Before</strong><p>No previous delivery proposal</p></div>${detailHtml("After", change.after, "#9fd8ca")}`}</section>`);
  return {
    subject,
    text: `Dear Supplier,\n\nThere have been new changes uploaded. Please sign in to review them and reconfirm the delivery.\n\n${textBlocks.join("\n\n---\n\n")}`,
    html: `<p>Dear Supplier,</p><p>There have been new changes uploaded. Please sign in to review them and reconfirm the delivery.</p>${htmlBlocks.join("")}`,
  };
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
  async sendSdsChanges({ sender, recipients, supplier, changes }) {
    return send({ sender, recipients, ...buildSdsChangeEmail({ supplier, changes }) });
  },
  async sendSupplierReschedule({ sender, recipients, shipmentNumber, supplier, reason, scheduledDate, scheduledTime, scheduledEndTime, alternativeDate, alternativeTime, alternativeEndTime }) {
    const scheduled = `${scheduledDate || "—"} at ${scheduledTime || "—"}${scheduledEndTime ? `–${scheduledEndTime}` : ""}`;
    const proposed = `${alternativeDate || "—"} at ${alternativeTime || "—"}${alternativeEndTime ? `–${alternativeEndTime}` : ""}`;
    return send({ sender, recipients, subject: `${supplier} requested a schedule change – ${shipmentNumber}`, text: `Dear Admin & Planner team,\n\nSupplier has requested a change to the delivery schedule due to unavailability at the planned time. Please sign in and review the proposed delivery schedule.\n\nSupplier: ${supplier}\nDelivery: ${shipmentNumber}\nReason: ${reason}\nScheduled time: ${scheduled}\nProposed time: ${proposed}`, html: `<p>Dear Admin &amp; Planner team,</p><p>Supplier has requested a change to the delivery schedule due to unavailability at the planned time. Please sign in and review the proposed delivery schedule.</p><div style="margin-top:16px;padding:14px;border:1px solid #f0c7a7;border-radius:10px"><p><b>Supplier:</b> ${escapeHtml(supplier)}<br><b>Delivery:</b> ${escapeHtml(shipmentNumber)}<br><b>Reason:</b> ${escapeHtml(reason)}<br><b>Scheduled time:</b> ${escapeHtml(scheduled)}<br><b>Proposed time:</b> ${escapeHtml(proposed)}</p></div>` });
  },
  async sendItemsReceived({ sender, recipients, shipmentNumber, deliveryCode, supplier, truckPlate, receivedAt, materialCodes }) {
    const codes = (materialCodes || []).join(", ") || "Not listed";
    const when = receivedAt ? new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" }).format(new Date(receivedAt)) : "Recorded now";
    return send({
      sender,
      recipients,
      subject: `Delivery received – ${shipmentNumber}`,
      text: `Dear Supplier,\n\nYour delivery has been marked as received.\n\nSupplier: ${supplier}\nDelivery: ${shipmentNumber}\nDelivery code: ${deliveryCode || "—"}\nTruck: ${truckPlate || "—"}\nReceived: ${when}\nMaterial codes: ${codes}`,
      html: `<p>Dear Supplier,</p><p>Your delivery has been marked as <strong>received</strong>.</p><div style="margin-top:16px;padding:14px;border:1px solid #9fd8ca;border-radius:10px"><p><b>Supplier:</b> ${escapeHtml(supplier)}<br><b>Delivery:</b> ${escapeHtml(shipmentNumber)}<br><b>Delivery code:</b> ${escapeHtml(deliveryCode || "—")}<br><b>Truck:</b> ${escapeHtml(truckPlate || "—")}<br><b>Received:</b> ${escapeHtml(when)}<br><b>Material codes:</b> ${escapeHtml(codes)}</p></div>`,
    });
  },
};
