/* SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 */
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

const status = document.getElementById("status");
document.getElementById("connect").addEventListener("click", async () => {
  try {
    await request({ type: "CONNECT_API" });
    status.textContent = "Connected to local API";
  } catch { status.textContent = "Start the local Jobkit API on port 8765"; }
});
document.getElementById("openLast").addEventListener("click", async () => {
  try {
    const data = await request({ type: "GET_LAST_APPLICATION" });
    if (!data?.apply_url) { status.textContent = "No prepared application in ledger"; return; }
    await request({ type: "OPEN_APPLY_TAB", url: data.apply_url });
    status.textContent = "Opened job — click Fill + Learn when ready";
  } catch { status.textContent = "Could not open a supported prepared job"; }
});
document.getElementById("clearData").addEventListener("click", async () => {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  status.textContent = "Extension cache, saved resume, and API session cleared; refresh job tabs";
  document.getElementById("resumeStatus").textContent = "No personal resume selected";
});
chrome.storage.local.get(["jobkitSemiAutoSubmit"], data => {
  document.getElementById("semiAuto").checked = data.jobkitSemiAutoSubmit !== false;
});
document.getElementById("semiAuto").addEventListener("change", event => {
  chrome.storage.local.set({ jobkitSemiAutoSubmit: event.target.checked });
});
status.textContent = "Click Connect API to connect locally";

const resumeStatus = document.getElementById("resumeStatus");
document.getElementById("ownResume").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error("Choose a PDF up to 4 MiB");
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    const saved = await request({ type: "SAVE_USER_RESUME", bytes, filename: file.name });
    resumeStatus.textContent = `Saved locally: ${saved.filename}`;
  } catch (error) { resumeStatus.textContent = error.message || "Could not save resume"; }
  event.target.value = "";
});
document.getElementById("removeResume").addEventListener("click", async () => {
  await request({ type: "REMOVE_USER_RESUME" });
  resumeStatus.textContent = "No personal resume selected";
});
request({ type: "GET_USER_RESUME_INFO" }).then(data => {
  resumeStatus.textContent = data.filename ? `Saved locally: ${data.filename}` : "No personal resume selected";
}).catch(() => { resumeStatus.textContent = "Could not read saved resume"; });
