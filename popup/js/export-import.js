/* eslint-disable no-undef */

const EXPORT_HEADER = "CENSORCAT_EXPORT";
const EXPORT_FILENAME_DEFAULT = "censorcat-export.txt";

function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    bytes.forEach((b) => {
        binary += String.fromCharCode(b);
    });
    return btoa(binary);
}

function base64ToUtf8(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

function isValidRegexPattern(pattern, caseSensitive) {
    const flags = caseSensitive ? "g" : "gi";
    try {
        new RegExp(pattern, flags);
        return true;
    } catch {
        return false;
    }
}

function validateImportedSettingsShape(obj) {
    if (!obj || typeof obj !== "object") {
        return false;
    }
    if (typeof obj.disableCensor !== "boolean") {
        return false;
    }
    if (!Number.isInteger(obj.censorMode) || obj.censorMode < 0 || obj.censorMode > 3) {
        return false;
    }
    if (typeof obj.censorChar !== "string" || obj.censorChar.length === 0) {
        return false;
    }
    if (typeof obj.censorSub !== "string") {
        return false;
    }
    if (!Array.isArray(obj.censoredPhrases)) {
        return false;
    }
    for (let i = 0; i < obj.censoredPhrases.length; i += 1) {
        const e = obj.censoredPhrases[i];
        if (!Array.isArray(e) || e.length < 3) {
            return false;
        }
        const [phrase, caseSens, isRx] = e;
        if (typeof phrase !== "string" || typeof caseSens !== "boolean" || typeof isRx !== "boolean") {
            return false;
        }
        if (isRx && !isValidRegexPattern(phrase, caseSens)) {
            return false;
        }
    }
    if (!Array.isArray(obj.ignoredSites)) {
        return false;
    }
    for (let i = 0; i < obj.ignoredSites.length; i += 1) {
        const e = obj.ignoredSites[i];
        if (!Array.isArray(e) || e.length < 2) {
            return false;
        }
        if (typeof e[0] !== "string" || typeof e[1] !== "boolean") {
            return false;
        }
    }
    return true;
}

function decodeImportFile(text) {
    const raw = String(text || "").replace(/^\uFEFF/, "").trim();
    if (!raw.startsWith(EXPORT_HEADER)) {
        return { ok: false };
    }
    const afterHeader = raw.slice(EXPORT_HEADER.length).trim();
    if (!afterHeader) {
        return { ok: false };
    }
    let jsonStr;
    try {
        jsonStr = base64ToUtf8(afterHeader);
    } catch {
        return { ok: false };
    }
    let obj;
    try {
        obj = JSON.parse(jsonStr);
    } catch {
        return { ok: false };
    }
    if (!obj || typeof obj !== "object" || obj.v !== 1) {
        return { ok: false };
    }
    const rest = { ...obj };
    delete rest.v;
    if (!validateImportedSettingsShape(rest)) {
        return { ok: false };
    }
    return { ok: true, settings: normalizeSettings(rest) };
}

function buildExportFileBody(settings) {
    const normalized = normalizeSettings(settings);
    const envelope = { v: 1, ...normalized };
    return `${EXPORT_HEADER}\n${utf8ToBase64(JSON.stringify(envelope))}`;
}

// Blob/data URLs are not reliably downloadable in some Firefox extension contexts;
// this page runs as an extension document, so downloads.download can resolve the blob URL.

function scheduleRevokeBlobUrl(downloadId, blobUrl) {
    const doneStates = new Set(["complete", "interrupted"]);

    const onChanged = (delta) => {
        if (delta.id !== downloadId || !delta.state || !doneStates.has(delta.state.current)) {
            return;
        }
        try {
            URL.revokeObjectURL(blobUrl);
        } catch {
            // ignore
        }
        browser.downloads.onChanged.removeListener(onChanged);
    };

    browser.downloads.onChanged.addListener(onChanged);

    window.setTimeout(() => {
        try {
            URL.revokeObjectURL(blobUrl);
        } catch {
            // ignore
        }
        browser.downloads.onChanged.removeListener(onChanged);
    }, 300_000);
}

async function downloadExportFile(body, filename) {
    if (typeof body !== "string") {
        throw new Error("Invalid export payload.");
    }
    const name = typeof filename === "string" && filename.length > 0
        ? filename
        : "censorcat-settings.txt";

    let blobUrl = null;
    try {
        const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
        blobUrl = URL.createObjectURL(blob);
        const downloadId = await browser.downloads.download({
            url: blobUrl,
            filename: name,
            saveAs: true
        });
        scheduleRevokeBlobUrl(downloadId, blobUrl);
        blobUrl = null;
    } catch (err) {
        if (blobUrl) {
            try {
                URL.revokeObjectURL(blobUrl);
            } catch {
                // ignore
            }
        }
        throw err;
    }
}

function setIoStatus(el, text, isError) {
    if (!el) {
        return;
    }
    el.textContent = text;
    el.classList.toggle("is-error", Boolean(isError));
}

function initExportImportPage() {
    const exportBtn = document.getElementById("export-settings");
    const exportStatus = document.getElementById("export-status");
    const input = document.getElementById("import-file");
    const importBtn = document.getElementById("import-choose");
    const importStatus = document.getElementById("import-status");

    if (!exportBtn || !exportStatus || !input || !importBtn || !importStatus) {
        return;
    }

    if (
        typeof buildExportFileBody !== "function"
        || typeof decodeImportFile !== "function"
        || typeof loadSettings !== "function"
        || typeof saveSettings !== "function"
    ) {
        setIoStatus(exportStatus, "Scripts failed to load. Please reload this tab to try again.", true);
        return;
    }

    exportBtn.addEventListener("click", () => {
        void (async () => {
            setIoStatus(exportStatus, "");
            try {
                const settings = await loadSettings();
                const body = buildExportFileBody(settings);
                await downloadExportFile(body, EXPORT_FILENAME_DEFAULT);
                setIoStatus(exportStatus, "Download started.", false);
            } catch (err) {
                const msg = err && typeof err.message === "string" ? err.message : String(err);
                setIoStatus(exportStatus, `Export failed.${msg ? ` ${msg}` : ""}`, true);
            }
        })();
    });

    importBtn.addEventListener("click", () => {
        setIoStatus(importStatus, "");
        input.value = "";
        input.click();
    });

    input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            void (async () => {
                try {
                    const text = typeof reader.result === "string" ? reader.result : "";
                    const parsed = decodeImportFile(text);
                    if (!parsed.ok) {
                        setIoStatus(
                            importStatus,
                            "This file could not be imported because it does not match the expected template.",
                            true
                        );
                        return;
                    }
                    await saveSettings(parsed.settings);
                    setIoStatus(
                        importStatus,
                        "Settings imported successfully. Reload open tabs to use the new settings. You can safely close this tab.",
                        false
                    );
                } catch (err) {
                    const msg = err && typeof err.message === "string" ? err.message : String(err);
                    setIoStatus(importStatus, `Import failed: ${msg}`, true);
                }
            })();
        };
        reader.onerror = () => {
            setIoStatus(importStatus, "Could not read the selected file.", true);
        };
        reader.readAsText(file, "UTF-8");
    });
}

initExportImportPage();
