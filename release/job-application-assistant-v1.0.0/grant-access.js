(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const host = params.get("host") || "";
  const pattern = params.get("pattern") || "";

  const el = {
    hostName: document.getElementById("hostName"),
    grantBtn: document.getElementById("grantBtn"),
    status: document.getElementById("status")
  };

  document.addEventListener("DOMContentLoaded", () => {
    if (!pattern) {
      el.status.textContent = "Missing site information. Close this tab and try again from the extension popup.";
      el.grantBtn.disabled = true;
      return;
    }

    el.hostName.textContent = host || pattern;
    el.grantBtn.addEventListener("click", handleGrant);
  });

  async function handleGrant() {
    el.grantBtn.disabled = true;
    el.status.textContent = "Requesting...";

    try {
      const granted = await new Promise((resolve) => {
        chrome.permissions.request({ origins: [pattern] }, (result) => resolve(Boolean(result)));
      });

      if (granted) {
        el.status.textContent = 'Access granted. Go back to your application tab and click "Fill Basic Fields on This Page" again.';
      } else {
        el.status.textContent = "Permission was not granted. You can try again anytime from the extension popup.";
        el.grantBtn.disabled = false;
      }
    } catch (_error) {
      el.status.textContent = "Something went wrong requesting permission.";
      el.grantBtn.disabled = false;
    }
  }
})();
