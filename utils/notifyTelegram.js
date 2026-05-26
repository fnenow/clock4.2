export async function notifyTelegramClockIn(entry) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!token || !chatId) {
    console.log("Telegram notification skipped: missing TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID.");
    return;
  }

  const workerName =
    entry.worker_name ||
    entry.workerName ||
    entry.name ||
    "Unknown worker";

  const projectName =
    entry.project_name ||
    entry.projectName ||
    "No project";

  const clockTime =
    entry.datetime_local ||
    entry.datetime_pst ||
    entry.datetime_utc ||
    "Unknown time";

  const note = entry.note || "";

  const message = `
🟢 CLOCK IN

Worker: ${workerName}
Project: ${projectName}
Time: ${clockTime}
Note: ${note}
`;

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

  console.log(`Telegram clock-in notification sent for ${workerName}`);
}
