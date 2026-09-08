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

const requestTime = (value) => {
  if (!value || Number.isNaN(Date.parse(value))) return "Recorded now";
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" }).format(new Date(value));
};

export const buildSupplierRescheduleEmail = ({ shipmentNumber, supplier, reason, requestedAt, scheduledDate, scheduledTime, alternativeDate, alternativeTime, quantityAllocations }) => {
  const scheduled = `${scheduledDate || "—"} at ${scheduledTime || "—"}`;
  const proposed = `${alternativeDate || scheduledDate || "—"} at ${alternativeTime || scheduledTime || "—"}`;
  const allocations = quantityAllocations || [];
  const allocationText = allocations.length
    ? allocations.map((row) => row.cannotDeliver
      ? `• ${row.materialCode}: ${row.quantity} ${row.uom}\n  CANNOT DELIVER\n  Reason: ${row.reason || "No reason provided"}`
      : `• ${row.materialCode}: ${row.quantity} ${row.uom}\n  Delivery: ${row.date} at ${row.time}`).join("\n")
    : "No quantity split was submitted.";
  const allocationHtml = allocations.length
    ? allocations.map((row) => `<tr><td style="padding:10px;border-bottom:1px solid #e5eaf1"><b>${escapeHtml(row.materialCode)}</b></td><td style="padding:10px;border-bottom:1px solid #e5eaf1">${escapeHtml(row.quantity)} ${escapeHtml(row.uom)}</td><td style="padding:10px;border-bottom:1px solid #e5eaf1">${row.cannotDeliver ? `<strong style="color:#b42318">Cannot deliver</strong><br><span>${escapeHtml(row.reason || "No reason provided")}</span>` : `<strong style="color:#137451">Scheduled</strong><br><span>${escapeHtml(row.date)} at ${escapeHtml(row.time)}</span>`}</td></tr>`).join("")
    : `<tr><td colspan="3" style="padding:12px;color:#667085">No quantity split was submitted.</td></tr>`;
  return {
    subject: `Schedule change awaiting approval – ${shipmentNumber}`,
    text: `DOCKFLOW · SCHEDULE CHANGE\n\nStatus: WAITING FOR APPROVAL\nRequested: ${requestTime(requestedAt)}\n\nSupplier: ${supplier}\nDelivery: ${shipmentNumber}\nRequest reason: ${reason || "Schedule change"}\nOriginal schedule: ${scheduled}\nProposed schedule: ${proposed}\n\nQUANTITY PLAN\n${allocationText}\n\nOpen DockFlow to approve or reject this request.`,
    html: `<div style="font-family:Arial,sans-serif;color:#14243b;max-width:720px"><div style="padding:18px 20px;border-radius:12px 12px 0 0;background:#123b72;color:#fff"><small style="letter-spacing:.12em">DOCKFLOW · SCHEDULE CHANGE</small><h1 style="margin:7px 0 0;font-size:22px">Waiting for approval</h1></div><div style="padding:18px 20px;border:1px solid #dce4ee;border-top:0;border-radius:0 0 12px 12px"><p style="margin:0 0 16px;color:#667085">Requested ${escapeHtml(requestTime(requestedAt))}</p><table style="width:100%;border-collapse:collapse"><tr><td style="padding:7px 0;color:#667085">Supplier</td><td style="padding:7px 0"><b>${escapeHtml(supplier)}</b></td></tr><tr><td style="padding:7px 0;color:#667085">Delivery</td><td style="padding:7px 0"><b>${escapeHtml(shipmentNumber)}</b></td></tr><tr><td style="padding:7px 0;color:#667085">Reason</td><td style="padding:7px 0">${escapeHtml(reason || "Schedule change")}</td></tr></table><div style="display:flex;gap:10px;margin:16px 0"><div style="flex:1;padding:13px;border:1px solid #e5eaf1;border-radius:9px"><small style="color:#667085">ORIGINAL</small><p style="margin:5px 0 0"><b>${escapeHtml(scheduled)}</b></p></div><div style="flex:1;padding:13px;border:1px solid #9fd8ca;border-radius:9px;background:#f1fbf7"><small style="color:#137451">PROPOSED</small><p style="margin:5px 0 0"><b>${escapeHtml(proposed)}</b></p></div></div><h2 style="margin:20px 0 8px;font-size:16px">Quantity plan</h2><table style="width:100%;border-collapse:collapse;border:1px solid #e5eaf1;border-radius:9px"><thead><tr style="background:#f5f7fa"><th style="padding:9px;text-align:left">Material</th><th style="padding:9px;text-align:left">Quantity</th><th style="padding:9px;text-align:left">Commitment</th></tr></thead><tbody>${allocationHtml}</tbody></table><p style="margin:18px 0 0">Open DockFlow to approve or reject this request.</p></div></div>`,
  };
};

export const emailNotifications = {
  async sendEcosystemRequest({ sender, recipients, shipment }) {
    return send({ sender, recipients, subject: `ULI delivery request – ${shipment.shipmentNumber}`, text: `ULI has requested delivery to ${shipment.items[0]?.deliverySite || 'site'} on ${shipment.scheduledDate} at ${shipment.scheduledTime} Manila.\n${shipment.items.map(item => `${item.materialCode}: ${item.quantity} ${item.uom}`).join('\n')}\nPlease sign in to confirm the truck and delivery details.` });
  },
  async sendDecision({ sender, recipients, shipmentNumber, supplier, decision, reason, scheduledDate, scheduledTime }) {
    const approved = decision === "APPROVED";
    const label = approved ? "Approved" : "Rejected";
    const tone = approved ? "#137451" : "#b42318";
    const schedule = scheduledDate ? `${scheduledDate} at ${scheduledTime || "—"}` : "See DockFlow";
    return send({ sender, recipients, subject: `Schedule ${label.toLowerCase()} – ${shipmentNumber}`, text: `DOCKFLOW · SCHEDULE DECISION\n\nStatus: ${label.toUpperCase()}\nSupplier: ${supplier || "Supplier"}\nDelivery: ${shipmentNumber}\nSchedule: ${schedule}\nReason: ${reason || (approved ? "Approved by the planning team" : "No reason provided")}\n\nSign in to DockFlow to review the delivery.`, html: `<div style="font-family:Arial,sans-serif;color:#14243b;max-width:620px"><div style="padding:18px 20px;border-radius:12px 12px 0 0;background:${tone};color:#fff"><small style="letter-spacing:.12em">DOCKFLOW · SCHEDULE DECISION</small><h1 style="margin:7px 0 0;font-size:22px">${label}</h1></div><div style="padding:18px 20px;border:1px solid #dce4ee;border-top:0;border-radius:0 0 12px 12px"><p><b>Supplier:</b> ${escapeHtml(supplier || "Supplier")}<br><b>Delivery:</b> ${escapeHtml(shipmentNumber)}<br><b>Schedule:</b> ${escapeHtml(schedule)}<br><b>Reason:</b> ${escapeHtml(reason || (approved ? "Approved by the planning team" : "No reason provided"))}</p><p>Sign in to DockFlow to review the delivery.</p></div></div>` });
  },
  async sendKpi({ sender, recipient, report, name }) {
    const value = n => n === null ? 'Not evaluated' : `${n}%`;
    return send({ sender, recipients: [recipient], subject: `DockFlow monthly KPI – ${name} – ${report.month}`, text: `Monthly performance: ${name}\nMonth: ${report.month}\nConfirmed: ${report.confirmed}\nInspected: ${report.evaluated}\nAwaiting inspection: ${report.awaitingInspection}\nOn time: ${value(report.onTimePercent)}\nIn full: ${value(report.inFullPercent)}\nOTIF: ${value(report.otifPercent)}\nGate out completed: ${report.completed}\nAverage site minutes: ${report.averageSiteMinutes ?? 'Not available'}\n\nOn time uses Gate in and the configured grace period. OTIF uses inspected original deliveries scheduled in this month; replacements are excluded.` });
  },
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
  async sendSupplierReschedule({ sender, recipients, ...details }) {
    return send({ sender, recipients, ...buildSupplierRescheduleEmail(details) });
  },
  async sendItemsReceived({ sender, recipients, shipmentNumber, deliveryCode, supplier, truckPlate, receivedAt, materialCodes, receipt }) {
    if (receipt && (!receipt.inFull || receipt.outcome === 'NOT_OTIF')) {
      const outstanding = receipt.items.filter(row => row.remainingQuantity > 0);
      const lines = outstanding.map(row => `${row.materialCode}: ${row.remainingQuantity} ${row.uom} follow-up on ${row.date} at ${row.time}. Reason: ${row.reason}`).join('\n');
      const rows = outstanding.map(row => `<tr><td style="padding:10px;border-bottom:1px solid #e5eaf1"><b>${escapeHtml(row.materialCode)}</b></td><td style="padding:10px;border-bottom:1px solid #e5eaf1">${escapeHtml(row.remainingQuantity)} ${escapeHtml(row.uom)}</td><td style="padding:10px;border-bottom:1px solid #e5eaf1">${escapeHtml(row.date)} at ${escapeHtml(row.time)}</td><td style="padding:10px;border-bottom:1px solid #e5eaf1">${escapeHtml(row.reason)}</td></tr>`).join("");
      return send({ sender, recipients, subject: `Receiving result: follow-up required – ${shipmentNumber}`, text: `DOCKFLOW · RECEIVING RESULT\n\nStatus: RECEIVED – NOT IN FULL\nSupplier: ${supplier}\nDelivery: ${shipmentNumber}\nTruck: ${truckPlate || "—"}\nReason: ${receipt.reason || "Partial delivery"}\n\nFOLLOW-UP ITEMS\n${lines || "No outstanding quantity."}\n\nA Follow up entry has been created in DockFlow for every scheduled outstanding quantity.`, html: `<div style="font-family:Arial,sans-serif;color:#14243b;max-width:720px"><div style="padding:18px 20px;border-radius:12px 12px 0 0;background:#b54708;color:#fff"><small style="letter-spacing:.12em">DOCKFLOW · RECEIVING RESULT</small><h1 style="margin:7px 0 0;font-size:22px">Received – Not in Full</h1></div><div style="padding:18px 20px;border:1px solid #dce4ee;border-top:0;border-radius:0 0 12px 12px"><p><b>Supplier:</b> ${escapeHtml(supplier)}<br><b>Delivery:</b> ${escapeHtml(shipmentNumber)}<br><b>Truck:</b> ${escapeHtml(truckPlate || "—")}<br><b>Reason:</b> ${escapeHtml(receipt.reason || "Partial delivery")}</p>${rows ? `<h2 style="font-size:16px">Follow-up items</h2><table style="width:100%;border-collapse:collapse;border:1px solid #e5eaf1"><thead><tr style="background:#f5f7fa"><th style="padding:9px;text-align:left">Material</th><th style="padding:9px;text-align:left">Outstanding</th><th style="padding:9px;text-align:left">Schedule</th><th style="padding:9px;text-align:left">Reason</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No outstanding quantity.</p>"}<p>A <b>Follow up</b> entry has been created in DockFlow for every scheduled outstanding quantity.</p></div></div>` });
    }
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
