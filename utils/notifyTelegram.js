async function sendTelegramMessage(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!token || !chatId) {
    console.log("Telegram notification skipped: missing token or chat ID.");
    return;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram notification failed: ${errorText}`);
  }
}

async function notifyTelegramClockIn(entry) {
  if (!entry) return;

  const workerName = entry.worker_name || entry.worker_id || "Unknown worker";
  const projectName = entry.project_name || entry.project_id || "No project";
  const clockTime = entry.datetime_local || "Unknown time";
  const note = entry.note || "";

  const message = `
🟢 CLOCK IN

Worker: ${workerName}
Project: ${projectName}
Time: ${clockTime}
Note: ${note}
`;

  await sendTelegramMessage(message);
  console.log(`Telegram clock-in notification sent for ${workerName}`);
}

async function notifyTelegramClockOut(entry) {
  if (!entry) return;

  const workerName = entry.worker_name || entry.worker_id || "Unknown worker";
  const projectName = entry.project_name || entry.project_id || "No project";
  const clockTime = entry.datetime_local || "Unknown time";
  const note = entry.note || "";

  const message = `
🔴 CLOCK OUT

Worker: ${workerName}
Project: ${projectName}
Time: ${clockTime}
Note: ${note}
`;

  await sendTelegramMessage(message);
  console.log(`Telegram clock-out notification sent for ${workerName}`);
}

module.exports = {
  notifyTelegramClockIn,
  notifyTelegramClockOut
};
