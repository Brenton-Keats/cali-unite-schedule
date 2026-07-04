// -- Cali Unite schedule app configuration ------------------------------
// Leave API_URL empty ("") to run in DEMO MODE with built-in sample data.
// After deploying the Google Apps Script, paste its Web App URL here.
// It looks like: https://script.google.com/macros/s/XXXXXXXX/exec
window.CONFIG = {
  EVENT_NAME: "Cali Unite",
  API_URL: "https://script.google.com/macros/s/AKfycbwBOfj24K3jkqlclwwROtkU6OXnGNtoJ2QjGEF_KzaZ2E7v7mNgjVILy_v1ZA1efyE2gA/exec",
  // Public display refresh - hundreds of phones may poll at this rate.
  POLL_MS: 10000,
  // Admin panel refresh - a handful of operator devices that need to see
  // changes (and lost-response confirmations) quickly.
  ADMIN_POLL_MS: 2000,
};
