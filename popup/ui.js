/* eslint-disable no-undef */

function setStatus(statusClass, text) {
    const statusEl = document.querySelector(".status");
    if (!statusEl) {
        return;
    }

    statusEl.innerHTML = `<p class="${statusClass}">${text}</p>`;
}

async function updateStatus() {
    const statusEl = document.querySelector(".status");
    if (!statusEl) {
        return;
    }

    try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const activeTab = tabs[0];

        if (!activeTab || activeTab.id === undefined) {
            setStatus("disabled", "Disabled");
            return;
        }

        // Keep loading state visible until the page is fully loaded.
        if (activeTab.status !== "complete") {
            setStatus("waiting", "Loading...");
            return;
        }

        const response = await browser.tabs.sendMessage(activeTab.id, {
            type: "GET_CENSOR_STATUS"
        });
        const enabled = Boolean(response && response.enabled);
        setStatus(enabled ? "enabled" : "disabled", enabled ? "Enabled" : "Disabled");
    } catch {
        // If page is still moving, keep waiting text. Otherwise treat as disabled.
        try {
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            const activeTab = tabs[0];
            if (activeTab && activeTab.status !== "complete") {
                setStatus("waiting", "Loading...");
                return;
            }
        } catch {
            // Ignore fallback tab query errors and show disabled below.
        }
        setStatus("disabled", "Disabled");
    }
}

updateStatus();

// Keep the indicator in sync while the popup is open.
browser.tabs.onActivated.addListener(() => {
    updateStatus();
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab && tab.active && (changeInfo.status === "loading" || changeInfo.status === "complete" || changeInfo.url)) {
        updateStatus();
    }
});