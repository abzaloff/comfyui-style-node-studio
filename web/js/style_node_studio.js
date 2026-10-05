import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const API_ROOT = "/style_node_studio/api";
const LAST_IMAGE_KEY = "comfyui_style_node_last_generated_img";
const CARD_SIZE_KEY = "comfyui_style_node_card_size";
const FAVORITES_CATEGORY = "Favs";
const MIN_GALLERY_HEIGHT = 280;
const DEFAULT_CARD_SIZE = 96;
const MIN_CARD_SIZE = 96;
const MAX_CARD_SIZE = 320;
const NODE_CARD_GAP = 6;

function clampCardSize(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_CARD_SIZE;
    return Math.min(MAX_CARD_SIZE, Math.max(MIN_CARD_SIZE, Math.round(numeric)));
}

function loadCardSize() {
    try {
        return clampCardSize(localStorage.getItem(CARD_SIZE_KEY));
    } catch (_) {
        return DEFAULT_CARD_SIZE;
    }
}

const cardSizeStore = {
    value: loadCardSize(),
    listeners: new Set(),

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    },

    set(value) {
        const next = clampCardSize(value);
        if (this.value === next) return;
        this.value = next;
        try {
            localStorage.setItem(CARD_SIZE_KEY, String(next));
        } catch (_) {
            // The setting still applies to the current session.
        }
        for (const listener of this.listeners) listener(next);
    },
};

function createElement(tag, options = {}) {
    const element = document.createElement(tag);
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.title) element.title = options.title;
    if (options.css) element.style.cssText = options.css;
    if (options.type) element.type = options.type;
    return element;
}

async function requestJson(path, options) {
    const response = await fetch(path, options);
    let payload = null;
    try {
        payload = await response.json();
    } catch (_) {
        // The HTTP status below still provides a useful fallback error.
    }
    if (!response.ok) {
        throw new Error(payload?.message || `Request failed (${response.status})`);
    }
    return payload;
}

const styleStore = {
    data: {},
    favorites: new Set(),
    loaded: false,
    pending: null,
    listeners: new Set(),
    favoriteListeners: new Set(),

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    },

    subscribeFavorites(listener) {
        this.favoriteListeners.add(listener);
        return () => this.favoriteListeners.delete(listener);
    },

    notify() {
        for (const listener of this.listeners) listener(this.data);
    },

    notifyFavorites(change) {
        for (const listener of this.favoriteListeners) listener(change);
    },

    isFavorite(category, name) {
        return this.favorites.has(selectionKey(category, name));
    },

    async setFavorite(category, name, favorite) {
        const key = selectionKey(category, name);
        const previous = this.favorites.has(key);
        if (previous === favorite) return;
        if (favorite) this.favorites.add(key);
        else this.favorites.delete(key);
        this.notifyFavorites({ category, name, favorite });
        try {
            await requestJson(`${API_ROOT}/set_favorite`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ category, name, favorite }),
            });
        } catch (error) {
            if (previous) this.favorites.add(key);
            else this.favorites.delete(key);
            this.notifyFavorites({ category, name, favorite: previous });
            throw error;
        }
    },

    async refresh() {
        if (this.pending) return this.pending;
        this.pending = (async () => {
            const payload = await requestJson(`${API_ROOT}/get_styles`);
            const nextData = payload?.styles ?? payload ?? {};
            this.data = nextData && typeof nextData === "object" ? nextData : {};
            const favoriteItems = Array.isArray(payload?.favorites) ? payload.favorites : [];
            this.favorites = new Set(
                favoriteItems
                    .filter((item) => item && typeof item.category === "string" && typeof item.name === "string")
                    .map((item) => selectionKey(item.category, item.name)),
            );
            this.loaded = true;
            if (Array.isArray(payload?.errors) && payload.errors.length) {
                console.warn("Style Node Studio skipped invalid style files:", payload.errors);
            }
            this.notify();
            return this.data;
        })();
        try {
            return await this.pending;
        } finally {
            this.pending = null;
        }
    },
};

function getLastGeneratedImage() {
    try {
        return localStorage.getItem(LAST_IMAGE_KEY) || "";
    } catch (_) {
        return "";
    }
}

function rememberGeneratedImage(url) {
    if (!url) return;
    try {
        localStorage.setItem(LAST_IMAGE_KEY, url);
    } catch (_) {
        // Private browsing or a full storage quota should not break the node.
    }
}

function imageOutputUrl(image) {
    if (!image || typeof image.filename !== "string") return "";
    const query = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder || "",
        type: image.type || "output",
    });
    const path = `/view?${query.toString()}`;
    return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}

try {
    api.addEventListener("executed", (event) => {
        const images = event?.detail?.output?.images;
        if (!Array.isArray(images) || !images.length) return;
        rememberGeneratedImage(imageOutputUrl(images[images.length - 1]));
    });
} catch (error) {
    console.warn("Style Node Studio cannot watch generated images:", error);
}

function safeThumbnailUrl(value) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (
        /^https?:\/\//i.test(trimmed) ||
        /^data:image\//i.test(trimmed) ||
        /^blob:/i.test(trimmed) ||
        trimmed.startsWith("/")
    ) {
        return trimmed;
    }
    // The original presets reference JPG files which are not shipped with the
    // project. Avoid a failing HTTP request and render a stable placeholder.
    return "";
}

function styleInitials(name) {
    return String(name || "Style")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || "")
        .join("") || "ST";
}

function createThumbnail(style, height, square = false) {
    const cover = createElement("div", {
        css: `${square ? `aspect-ratio:1 / 1;max-height:${height}px;` : `height:${height}px;`}width:100%;background:linear-gradient(135deg,#2a2317,#111);position:relative;overflow:hidden;flex-shrink:0;`,
    });
    const placeholder = createElement("div", {
        text: styleInitials(style?.name),
        css: "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#8f7a4e;font-size:24px;font-weight:800;letter-spacing:1px;",
    });
    cover.appendChild(placeholder);

    const url = safeThumbnailUrl(style?.thumbnail);
    if (url) {
        const image = createElement("img", {
            css: "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;",
        });
        image.alt = "";
        image.loading = "lazy";
        image.src = url;
        image.onerror = () => image.remove();
        cover.appendChild(image);
    }
    return cover;
}

function insertTokenAtCursor(textarea, token = "{prompt}") {
    const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
    const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
    textarea.setRangeText(token, start, end, "end");
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

async function imageBlobFromElementSource(source) {
    if (source instanceof Blob) return source;
    if (typeof source !== "string" || !source.trim()) {
        throw new Error("Choose an image first");
    }
    const trimmed = source.trim();
    let response;
    try {
        let comfyViewPath = "";
        if (typeof api.apiURL === "function" && typeof location !== "undefined") {
            const sourceUrl = new URL(trimmed, location.href);
            const viewUrl = new URL(api.apiURL("/view"), location.href);
            if (sourceUrl.origin === viewUrl.origin && sourceUrl.pathname === viewUrl.pathname) {
                comfyViewPath = `/view${sourceUrl.search}`;
            }
        }
        response = comfyViewPath && typeof api.fetchApi === "function"
            ? await api.fetchApi(comfyViewPath, { cache: "no-store" })
            : await fetch(trimmed, { cache: "no-store" });
    } catch (error) {
        console.warn("Style Node Studio cannot read thumbnail source:", error);
        throw new Error("Cannot read this image URL. Check that the generated file still exists.");
    }
    if (!response.ok) throw new Error(`Cannot read thumbnail (${response.status})`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) {
        throw new Error(`Selected URL is not an image (${blob.type || "unknown content type"})`);
    }
    return blob;
}

async function squareImageBlob(source, size = 512) {
    const sourceBlob = await imageBlobFromElementSource(source);
    let bitmap;
    if (typeof createImageBitmap === "function") {
        bitmap = await createImageBitmap(sourceBlob);
    } else {
        bitmap = await new Promise((resolve, reject) => {
            const image = new Image();
            const objectUrl = URL.createObjectURL(sourceBlob);
            image.onload = () => {
                URL.revokeObjectURL(objectUrl);
                resolve(image);
            };
            image.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                reject(new Error("Cannot decode selected image"));
            };
            image.src = objectUrl;
        });
    }

    const width = bitmap.width || bitmap.naturalWidth;
    const height = bitmap.height || bitmap.naturalHeight;
    if (!width || !height) throw new Error("Selected image has invalid dimensions");
    const cropSize = Math.min(width, height);
    const sourceX = (width - cropSize) / 2;
    const sourceY = (height - cropSize) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, sourceX, sourceY, cropSize, cropSize, 0, 0, size, size);
    bitmap.close?.();
    return await new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => blob ? resolve(blob) : reject(new Error("Cannot create square thumbnail")),
            "image/webp",
            0.88,
        );
    });
}

async function persistThumbnail(source, category, name) {
    const image = await squareImageBlob(source);
    const formData = new FormData();
    formData.append("category", category);
    formData.append("name", name);
    formData.append("image", image, "thumbnail.webp");
    const payload = await requestJson(`${API_ROOT}/save_thumbnail`, {
        method: "POST",
        body: formData,
    });
    return payload.thumbnail;
}

async function replaceStyleThumbnail(category, style, source) {
    const name = String(style?.name || "").trim();
    if (!name) throw new Error("Style name is required");
    const thumbnail = await persistThumbnail(source, category, name);
    await requestJson(`${API_ROOT}/save_style`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            category,
            original_category: category,
            original_name: name,
            style: {
                name,
                prompt: String(style?.prompt || ""),
                negative_prompt: String(style?.negative_prompt || ""),
                thumbnail,
            },
        }),
    });
}

function parseSelection(value) {
    if (typeof value !== "string" || !value.trim()) return [];
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed
                    .filter((item) => item && typeof item.category === "string" && typeof item.name === "string")
                    .map((item) => ({ category: item.category, name: item.name }));
            }
        } catch (_) {
            // Fall through to the legacy comma-separated format.
        }
    }
    return trimmed.split(",").map((item) => {
        const valuePart = item.trim();
        const separator = valuePart.indexOf(" / ");
        return separator >= 0
            ? { category: valuePart.slice(0, separator), name: valuePart.slice(separator + 3) }
            : { category: "", name: valuePart };
    }).filter((item) => item.name);
}

function selectionKey(category, name) {
    return JSON.stringify([category, name]);
}

function favoriteStyleEntries(data = styleStore.data) {
    const entries = [];
    for (const category of Object.keys(data || {})) {
        const styles = data[category];
        if (!Array.isArray(styles)) continue;
        for (const style of styles) {
            const name = String(style?.name || "");
            if (styleStore.isFavorite(category, name)) entries.push({ category, style });
        }
    }
    return entries;
}

function updateFavoriteButton(button) {
    const favorite = styleStore.favorites.has(button.dataset.favoriteKey);
    button.textContent = favorite ? "★" : "☆";
    button.style.color = favorite ? "#fbbf24" : "#facc15";
    button.style.background = favorite ? "rgba(0,0,0,.78)" : "rgba(0,0,0,.58)";
    button.title = favorite ? "Remove from Favs" : "Add to Favs";
    button.setAttribute("aria-label", button.title);
}

function refreshFavoriteButtons(root) {
    for (const button of root.querySelectorAll("[data-favorite-key]")) {
        updateFavoriteButton(button);
    }
}

function createFavoriteButton(category, name, onError) {
    const button = createElement("button", {
        type: "button",
        css: "position:absolute;top:3px;right:3px;z-index:3;width:16px;height:16px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border:1px solid rgba(250,204,21,.72);border-radius:4px;font-size:14px;line-height:1;padding:0;cursor:pointer;",
    });
    button.dataset.favoriteKey = selectionKey(category, name);
    updateFavoriteButton(button);
    button.onpointerdown = (event) => event.stopPropagation();
    button.onclick = async (event) => {
        event.stopPropagation();
        const favorite = !styleStore.isFavorite(category, name);
        button.disabled = true;
        try {
            await styleStore.setFavorite(category, name, favorite);
        } catch (error) {
            onError?.(error);
        } finally {
            button.disabled = false;
            updateFavoriteButton(button);
        }
    };
    return button;
}

function updateFavsOption(select) {
    const option = [...select.options].find((item) => item.value === FAVORITES_CATEGORY);
    if (option) option.textContent = `⭐ ${FAVORITES_CATEGORY} (${styleStore.favorites.size})`;
}

function hideLegacyWidget(widget) {
    if (!widget || widget._snsHidden) return;
    widget._snsHidden = true;
    // Current ComfyUI and legacy LiteGraph both skip widgets with this flag,
    // while their values remain serializable for the backend and old workflows.
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    widget.draw = () => undefined;
    if (widget.element) widget.element.style.display = "none";
}

function setNodeDirty(node) {
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

function showStyleManagerModal(node, editData) {
    document.getElementById("style-node-studio-modal")?.remove();

    const modal = createElement("div", {
        css: "position:fixed;inset:0;background:rgba(0,0,0,.88);backdrop-filter:blur(8px);z-index:10000;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;",
    });
    modal.id = "style-node-studio-modal";
    modal.innerHTML = `
        <div data-sns-manager-panel style="background:#141414;color:#fff;border-radius:14px;width:70vw;min-width:920px;max-width:95vw;height:85vh;max-height:800px;border:1px solid #2a2a2a;box-shadow:0 25px 50px -12px rgba(0,0,0,.7);display:flex;flex-direction:column;overflow:hidden;">
            <div style="display:flex;justify-content:space-between;align-items:center;background:#0b0b0b;padding:16px 24px;border-bottom:1px solid #262626;">
                <div><h3 style="margin:0;font-size:16px;color:#f3f4f6;">🎨 Style Node Studio — Manager</h3><p style="margin:3px 0 0;font-size:12px;color:#9ca3af;">Add, edit and delete style presets</p></div>
                <button id="sns-close" type="button" style="background:#262626;border:1px solid #3d3d3d;color:#e5e7eb;font-size:16px;padding:6px 12px;border-radius:8px;cursor:pointer;">✕</button>
            </div>
            <div style="display:grid;grid-template-columns:320px minmax(0,1fr);flex:1;min-height:0;overflow:hidden;">
                <div style="background:#111;padding:20px;border-right:1px solid #262626;overflow-y:auto;display:flex;flex-direction:column;gap:12px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;"><h4 id="sns-form-title" style="margin:0;font-size:14px;color:#f59e0b;">➕ Add New Style</h4><button id="sns-reset-btn" type="button" style="background:transparent;border:none;color:#9ca3af;font-size:11px;cursor:pointer;text-decoration:underline;">Reset form</button></div>
                    <label style="font-size:11px;color:#9ca3af;font-weight:600;">Category<select id="sns-category-select" style="display:block;width:100%;margin-top:4px;background:#1c1c1c;border:1px solid #333;color:#fff;padding:7px 8px;border-radius:6px;font-size:11px;box-sizing:border-box;"><option value="">— Choose existing category —</option></select><input id="sns-cat" list="sns-category-list" type="text" placeholder="or type a new category" autocomplete="off" style="display:block;width:100%;margin-top:5px;background:#1c1c1c;border:1px solid #333;color:#fff;padding:8px 10px;border-radius:6px;font-size:12px;box-sizing:border-box;"><datalist id="sns-category-list"></datalist></label>
                    <label style="font-size:11px;color:#9ca3af;font-weight:600;">Style name<input id="sns-name" type="text" placeholder="e.g. Cyberpunk Neon" style="display:block;width:100%;margin-top:4px;background:#1c1c1c;border:1px solid #333;color:#fff;padding:8px 10px;border-radius:6px;font-size:12px;box-sizing:border-box;"></label>
                    <label style="font-size:11px;color:#9ca3af;font-weight:600;"><span style="display:flex;align-items:center;justify-content:space-between;gap:6px;">Positive prompt<button id="sns-token-pos" type="button" style="background:#3a2b12;border:1px solid #7c5a1d;color:#fbbf24;font-size:10px;padding:3px 7px;border-radius:5px;cursor:pointer;">Insert {prompt}</button></span><textarea id="sns-pos" style="display:block;width:100%;height:90px;margin-top:4px;background:#1c1c1c;border:1px solid #333;color:#fff;padding:8px;border-radius:6px;font-size:11px;resize:vertical;box-sizing:border-box;"></textarea></label>
                    <label style="font-size:11px;color:#9ca3af;font-weight:600;"><span style="display:flex;align-items:center;justify-content:space-between;gap:6px;">Negative prompt<button id="sns-token-neg" type="button" style="background:#3a2b12;border:1px solid #7c5a1d;color:#fbbf24;font-size:10px;padding:3px 7px;border-radius:5px;cursor:pointer;">Insert {prompt}</button></span><textarea id="sns-neg" style="display:block;width:100%;height:70px;margin-top:4px;background:#1c1c1c;border:1px solid #333;color:#fff;padding:8px;border-radius:6px;font-size:11px;resize:vertical;box-sizing:border-box;"></textarea></label>
                    <label style="font-size:11px;color:#9ca3af;font-weight:600;">Thumbnail source<input id="sns-thumb" type="text" placeholder="ComfyUI image URL or external URL" style="display:block;width:100%;margin-top:4px;background:#1c1c1c;border:1px solid #333;color:#fff;padding:8px 10px;border-radius:6px;font-size:11px;box-sizing:border-box;"></label>
                    <input id="sns-file-input" type="file" accept="image/png,image/jpeg,image/webp" hidden>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;"><button id="sns-file-image" type="button" style="background:#262626;border:1px solid #3d3d3d;color:#e5e7eb;padding:7px;border-radius:6px;font-size:11px;cursor:pointer;">Choose image</button><button id="sns-last-image" type="button" style="background:#262626;border:1px solid #3d3d3d;color:#e5e7eb;padding:7px;border-radius:6px;font-size:11px;cursor:pointer;">Use last generated</button></div>
                    <button id="sns-save" type="button" style="background:#f59e0b;color:#000;font-weight:bold;border:none;padding:10px;border-radius:6px;font-size:12px;cursor:pointer;">Save style</button>
                    <label style="background:#171717;border:1px solid #2f2f2f;border-radius:7px;padding:8px 10px;font-size:11px;color:#9ca3af;font-weight:600;"><span style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;"><span>Card size</span><output id="sns-card-size-value" style="color:#f59e0b;font-variant-numeric:tabular-nums;">96 px</output></span><input id="sns-card-size" type="range" min="96" max="320" step="1" style="display:block;width:100%;margin:0;accent-color:#f59e0b;cursor:pointer;"></label>
                    <button id="sns-delete-current" type="button" style="display:none;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4);color:#ef4444;padding:8px;border-radius:6px;font-size:11px;cursor:pointer;">Delete this preset</button>
                    <div id="sns-form-status" role="status" style="min-height:16px;font-size:11px;color:#9ca3af;"></div>
                </div>
                <div style="background:#141414;padding:20px;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;">
                    <div style="display:grid;grid-template-columns:minmax(150px,200px) auto minmax(140px,1fr) auto;align-items:center;margin-bottom:14px;gap:8px;"><select id="sns-manager-category" style="min-width:0;background:#0b0b0b;border:1px solid #2a2a2a;color:#f59e0b;padding:8px 10px;border-radius:8px;font-size:12px;font-weight:700;"><option value="All">📁 All Categories</option></select><button id="sns-delete-category" type="button" disabled style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.28);color:#ef4444;padding:8px 10px;border-radius:8px;font-size:11px;white-space:nowrap;cursor:not-allowed;opacity:.45;">🗑 Delete category</button><div style="position:relative;min-width:0;"><input id="sns-search" type="text" placeholder="🔍 Search styles..." style="width:100%;min-width:0;box-sizing:border-box;background:#0b0b0b;border:1px solid #2a2a2a;color:#fff;padding:8px 30px 8px 12px;border-radius:8px;font-size:12px;"><button id="sns-search-clear" type="button" title="Clear search" aria-label="Clear search" style="display:none;position:absolute;right:6px;top:50%;transform:translateY(-50%);width:20px;height:20px;align-items:center;justify-content:center;background:transparent;border:0;color:#9ca3af;font-size:16px;line-height:1;padding:0;cursor:pointer;">×</button></div><span id="sns-count" style="font-size:12px;color:#9ca3af;white-space:nowrap;"></span></div>
                    <div id="sns-grid" style="flex:1;min-height:0;overflow-y:auto;display:block;padding-right:4px;"></div>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);

    const form = {
        title: modal.querySelector("#sns-form-title"),
        category: modal.querySelector("#sns-cat"),
        categorySelect: modal.querySelector("#sns-category-select"),
        name: modal.querySelector("#sns-name"),
        positive: modal.querySelector("#sns-pos"),
        negative: modal.querySelector("#sns-neg"),
        thumbnail: modal.querySelector("#sns-thumb"),
        status: modal.querySelector("#sns-form-status"),
        deleteCurrent: modal.querySelector("#sns-delete-current"),
    };
    const managerPanel = modal.querySelector("[data-sns-manager-panel]");
    const managerCategory = modal.querySelector("#sns-manager-category");
    const deleteCategoryButton = modal.querySelector("#sns-delete-category");
    const managerSearchInput = modal.querySelector("#sns-search");
    const managerSearchClear = modal.querySelector("#sns-search-clear");
    const cardSizeInput = modal.querySelector("#sns-card-size");
    const cardSizeValue = modal.querySelector("#sns-card-size-value");
    let editing = null;
    let thumbnailFile = null;
    let thumbnailDirty = false;

    const setStatus = (message, isError = false) => {
        form.status.textContent = message;
        form.status.style.color = isError ? "#ef4444" : "#86efac";
    };

    const resetForm = () => {
        editing = null;
        form.title.textContent = "➕ Add New Style";
        form.category.value = "";
        form.categorySelect.value = "";
        form.name.value = "";
        form.positive.value = "";
        form.negative.value = "";
        form.thumbnail.value = "";
        form.deleteCurrent.style.display = "none";
        thumbnailFile = null;
        thumbnailDirty = false;
        setStatus("");
    };

    const fillForm = (category, style) => {
        editing = { category, name: String(style.name || "") };
        form.title.textContent = `✏️ Edit: ${editing.name}`;
        form.category.value = category;
        form.categorySelect.value = category;
        form.name.value = style.name || "";
        form.positive.value = style.prompt || "";
        form.negative.value = style.negative_prompt || "";
        form.thumbnail.value = style.thumbnail || "";
        form.deleteCurrent.style.display = "block";
        thumbnailFile = null;
        thumbnailDirty = false;
        setStatus("");
    };

    const deletePreset = async (category, name) => {
        if (!confirm(`Delete style '${name}'?`)) return;
        try {
            await requestJson(`${API_ROOT}/delete_style`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ category, name }),
            });
            if (editing?.category === category && editing?.name === name) resetForm();
            await styleStore.refresh();
            setStatus("Preset deleted");
        } catch (error) {
            setStatus(error.message, true);
        }
    };

    const deleteCategory = async () => {
        const category = managerCategory.value;
        if (!category || category === "All" || category === FAVORITES_CATEGORY) return;
        const styleCount = Array.isArray(styleStore.data?.[category])
            ? styleStore.data[category].length
            : 0;
        const presetText = styleCount === 1 ? "1 preset" : `${styleCount} presets`;
        if (!confirm(
            `Delete category '${category}' and all ${presetText}?\n\n` +
            "Its JSON file and thumbnail folder will be permanently deleted. This cannot be undone.",
        )) return;

        const previousText = deleteCategoryButton.textContent;
        deleteCategoryButton.disabled = true;
        deleteCategoryButton.textContent = "Deleting...";
        try {
            await requestJson(`${API_ROOT}/delete_category`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ category }),
            });
            if (editing?.category === category) resetForm();
            await styleStore.refresh();
            setStatus(`Category '${category}' deleted`);
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            deleteCategoryButton.textContent = previousText;
        }
    };

    const renderManager = (data) => {
        const grid = modal.querySelector("#sns-grid");
        const count = modal.querySelector("#sns-count");
        const categoryList = modal.querySelector("#sns-category-list");
        const query = (managerSearchInput.value || "").trim().toLowerCase();
        const fragment = document.createDocumentFragment();
        let total = 0;

        categoryList.replaceChildren();
        form.categorySelect.replaceChildren(new Option("— Choose existing category —", ""));
        const categories = Object.keys(data || {}).sort((left, right) => left.localeCompare(right));
        const currentManagerCategory = managerCategory.value || "All";
        managerCategory.replaceChildren(
            new Option("📁 All Categories", "All"),
            new Option(`⭐ ${FAVORITES_CATEGORY} (${styleStore.favorites.size})`, FAVORITES_CATEGORY),
        );
        for (const category of categories) {
            categoryList.appendChild(new Option(category, category));
            form.categorySelect.appendChild(new Option(category, category));
            managerCategory.appendChild(new Option(`📁 ${category}`, category));
        }
        managerCategory.value = categories.includes(currentManagerCategory) || currentManagerCategory === FAVORITES_CATEGORY
            ? currentManagerCategory
            : "All";
        const canDeleteCategory = managerCategory.value !== "All" && managerCategory.value !== FAVORITES_CATEGORY;
        deleteCategoryButton.disabled = !canDeleteCategory;
        deleteCategoryButton.style.cursor = canDeleteCategory ? "pointer" : "not-allowed";
        deleteCategoryButton.style.opacity = canDeleteCategory ? "1" : ".45";
        form.categorySelect.value = categories.includes(form.category.value) ? form.category.value : "";

        const searchAllCategories = Boolean(query);
        const sections = !searchAllCategories && managerCategory.value === FAVORITES_CATEGORY
            ? [{ title: FAVORITES_CATEGORY, entries: favoriteStyleEntries(data) }]
            : categories
                .filter((category) => searchAllCategories || managerCategory.value === "All" || managerCategory.value === category)
                .map((category) => ({
                    title: category,
                    entries: Array.isArray(data[category])
                        ? data[category].map((style) => ({ category, style }))
                        : [],
                }));

        for (const sectionData of sections) {
            const matchingEntries = [...sectionData.entries]
                .sort((left, right) => String(left.style?.name || "").localeCompare(String(right.style?.name || "")))
                .filter(({ style }) => {
                    const name = String(style?.name || "");
                    const prompt = String(style?.prompt || "");
                    return !query || name.toLowerCase().includes(query) || prompt.toLowerCase().includes(query);
                });
            if (!matchingEntries.length) continue;

            const section = createElement("section", { css: "margin:0 0 16px;" });
            const heading = createElement("div", { css: "display:flex;align-items:center;gap:8px;margin:0 0 10px;padding-bottom:7px;border-bottom:1px solid #2a2a2a;" });
            heading.append(
                createElement("h4", { text: sectionData.title, css: "margin:0;color:#f59e0b;font-size:13px;font-weight:800;" }),
                createElement("span", { text: String(matchingEntries.length), css: "background:#2a2210;color:#d6a84b;font-size:10px;padding:2px 6px;border-radius:999px;" }),
            );
            const categoryGrid = createElement("div", { css: "display:grid;grid-template-columns:repeat(auto-fill,var(--sns-card-size));gap:8px;align-items:start;" });

            for (const { category, style } of matchingEntries) {
                const name = String(style?.name || "");
                const prompt = String(style?.prompt || "");
                total += 1;

                const card = createElement("div", {
                    css: "width:var(--sns-card-size);min-width:0;min-height:calc(var(--sns-card-size) + 38px);background:#0b0b0b;border:1px solid #34302a;border-radius:8px;overflow:hidden;display:flex;flex-direction:column;cursor:pointer;box-sizing:border-box;",
                    title: `${category} / ${name} — click to edit`,
                });
                const cover = createThumbnail(style, MAX_CARD_SIZE, true);
                cover.appendChild(createFavoriteButton(category, name, (error) => setStatus(error.message, true)));
                card.appendChild(cover);
                const body = createElement("div", { css: "padding:5px;display:flex;flex:1;flex-direction:column;gap:3px;min-height:38px;" });
                const nameElement = createElement("div", { text: name, css: "color:#f3f4f6;font-size:10px;line-height:1.15;font-weight:700;max-height:24px;overflow:hidden;" });
                const promptElement = createElement("div", { text: prompt || "No positive prompt", css: "color:#9ca3af;font-size:8px;line-height:1.2;height:19px;overflow:hidden;" });
                body.append(nameElement, promptElement);
                card.appendChild(body);

                const selectForEdit = () => fillForm(category, style);
                card.onclick = selectForEdit;
                categoryGrid.appendChild(card);
            }
            section.append(heading, categoryGrid);
            fragment.appendChild(section);
        }

        grid.replaceChildren(fragment);
        if (!total) grid.appendChild(createElement("div", { text: "No matching styles found", css: "color:#888;font-size:12px;text-align:center;padding:30px;" }));
        count.textContent = `${total} styles`;
    };

    const unsubscribe = styleStore.subscribe(renderManager);
    const unsubscribeCardSize = cardSizeStore.subscribe((size) => {
        managerPanel.style.setProperty("--sns-card-size", `${size}px`);
        cardSizeInput.value = String(size);
        cardSizeValue.textContent = `${size} px`;
    });
    const unsubscribeFavorites = styleStore.subscribeFavorites(() => {
        updateFavsOption(managerCategory);
        if (managerCategory.value === FAVORITES_CATEGORY) renderManager(styleStore.data);
        else refreshFavoriteButtons(modal);
    });
    const close = () => {
        unsubscribe();
        unsubscribeFavorites();
        unsubscribeCardSize();
        modal.remove();
    };
    modal.querySelector("#sns-close").onclick = close;
    modal.onclick = (event) => { if (event.target === modal) close(); };
    modal.querySelector("#sns-reset-btn").onclick = resetForm;
    const updateManagerSearchClear = () => {
        managerSearchClear.style.display = managerSearchInput.value ? "flex" : "none";
    };
    managerSearchInput.oninput = () => {
        updateManagerSearchClear();
        renderManager(styleStore.data);
    };
    managerSearchClear.onclick = () => {
        managerSearchInput.value = "";
        updateManagerSearchClear();
        managerSearchInput.focus();
        renderManager(styleStore.data);
    };
    modal.querySelector("#sns-manager-category").onchange = () => renderManager(styleStore.data);
    cardSizeInput.value = String(cardSizeStore.value);
    cardSizeValue.textContent = `${cardSizeStore.value} px`;
    managerPanel.style.setProperty("--sns-card-size", `${cardSizeStore.value}px`);
    cardSizeInput.oninput = () => cardSizeStore.set(cardSizeInput.value);
    deleteCategoryButton.onclick = deleteCategory;
    form.categorySelect.onchange = () => {
        if (form.categorySelect.value) form.category.value = form.categorySelect.value;
    };
    form.category.oninput = () => {
        form.categorySelect.value = [...form.categorySelect.options].some(
            (option) => option.value === form.category.value
        ) ? form.category.value : "";
    };
    const positiveTokenButton = modal.querySelector("#sns-token-pos");
    const negativeTokenButton = modal.querySelector("#sns-token-neg");
    // Keep the textarea selection intact while the toolbar button is pressed.
    positiveTokenButton.onpointerdown = (event) => event.preventDefault();
    negativeTokenButton.onpointerdown = (event) => event.preventDefault();
    positiveTokenButton.onclick = () => insertTokenAtCursor(form.positive);
    negativeTokenButton.onclick = () => insertTokenAtCursor(form.negative);
    form.thumbnail.oninput = () => {
        thumbnailFile = null;
        thumbnailDirty = true;
    };
    const fileInput = modal.querySelector("#sns-file-input");
    modal.querySelector("#sns-file-image").onclick = () => fileInput.click();
    fileInput.onchange = () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        thumbnailFile = file;
        thumbnailDirty = true;
        form.thumbnail.value = `Local file: ${file.name}`;
        setStatus("Image selected; it will be cropped to a square on save");
    };
    modal.querySelector("#sns-last-image").onclick = () => {
        const image = getLastGeneratedImage();
        if (image) {
            thumbnailFile = null;
            thumbnailDirty = true;
            form.thumbnail.value = image;
            setStatus("Last generated image selected; it will be saved locally");
        } else {
            setStatus("Generate an image first", true);
        }
    };
    form.deleteCurrent.onclick = async () => {
        if (editing) await deletePreset(editing.category, editing.name);
    };
    modal.querySelector("#sns-save").onclick = async () => {
        const category = form.category.value.trim() || "Custom";
        const name = form.name.value.trim();
        if (!name) {
            setStatus("Style name is required", true);
            return;
        }
        const updatingSameStyle = editing?.category === category && editing?.name === name;
        if (!updatingSameStyle && styleStore.data[category]?.some((style) => style.name === name)) {
            setStatus("A style with this name already exists in the category", true);
            return;
        }
        try {
            setStatus("Saving...");
            const identityChanged = Boolean(
                editing && (editing.category !== category || editing.name !== name)
            );
            let thumbnail = form.thumbnail.value.trim();
            const managedThumbnail = thumbnail.startsWith(`${API_ROOT}/thumbnail?`);
            const shouldPersistThumbnail = Boolean(
                thumbnailFile ||
                (thumbnail && thumbnailDirty) ||
                (thumbnail && managedThumbnail && identityChanged)
            );
            if (shouldPersistThumbnail) {
                thumbnail = await persistThumbnail(thumbnailFile || thumbnail, category, name);
            }
            await requestJson(`${API_ROOT}/save_style`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    category,
                    original_category: editing?.category,
                    original_name: editing?.name,
                    style: {
                        name,
                        prompt: form.positive.value,
                        negative_prompt: form.negative.value,
                        thumbnail,
                    },
                }),
            });
            resetForm();
            await styleStore.refresh();
            setStatus("Style saved");
        } catch (error) {
            setStatus(error.message, true);
        }
    };

    if (editData?.style) fillForm(editData.cat || "Custom", editData.style);
    renderManager(styleStore.data);
    if (!styleStore.loaded) {
        styleStore.refresh().catch((error) => setStatus(error.message, true));
    }
}

if (typeof window !== "undefined") window.showStyleManagerModal = showStyleManagerModal;

function setupStyleNodeWidget(node) {
    if (node._snsInitialized) return;
    node._snsInitialized = true;
    node.properties ||= {};

    const categoryWidget = node.widgets?.find((widget) => widget.name === "category");
    const selectionWidget = node.widgets?.find((widget) => widget.name === "selected_styles");
    if (!node.properties.selected_styles && typeof selectionWidget?.value === "string") {
        node.properties.selected_styles = selectionWidget.value;
    }
    node.properties.selected_styles ||= "";
    hideLegacyWidget(categoryWidget);
    hideLegacyWidget(selectionWidget);

    const container = createElement("div", {
        css: "width:100%;height:100%;min-height:280px;background:#0f0e0c;border:1px solid #2b271f;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;margin:4px 0;pointer-events:auto;",
    });
    container.innerHTML = `
        <div style="background:#1e1c18;padding:6px 10px;border-bottom:1px solid #383328;display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
            <div style="display:grid;grid-template-columns:clamp(93px,calc(20% - 18px),158px) minmax(0,1fr) auto;align-items:center;gap:6px;"><div style="position:relative;min-width:0;"><input data-sns="search" type="text" placeholder="🔍 Search styles..." style="min-width:0;width:100%;box-sizing:border-box;background:#141310;border:1px solid #3d3626;color:#fff;font-size:11px;padding:4px 24px 4px 8px;border-radius:6px;outline:none;"><button data-sns="search-clear" type="button" title="Clear search" aria-label="Clear search" style="display:none;position:absolute;right:4px;top:50%;transform:translateY(-50%);width:17px;height:17px;align-items:center;justify-content:center;background:transparent;border:0;color:#a89d8a;font-size:14px;line-height:1;padding:0;cursor:pointer;">×</button></div><div data-sns="selected-list" aria-label="Selected styles" style="height:25px;min-width:0;display:flex;align-items:center;gap:4px;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;background:#141310;border:1px solid #3d3626;border-radius:6px;padding:2px 4px;box-sizing:border-box;"></div><div style="display:flex;align-items:center;gap:4px;"><button data-sns="toggle-all" type="button" title="Disable all selected styles" aria-label="Toggle all selected styles" style="position:relative;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 22px;background:#2b271f;border:1px solid #3d3626;color:#f3f4f6;font-size:18px;line-height:1;padding:0;border-radius:6px;cursor:pointer;">◎<span data-sns="toggle-all-slash" style="display:none;position:absolute;width:17px;height:2px;background:currentColor;transform:rotate(-45deg);pointer-events:none;"></span></button><button data-sns="clear" type="button" style="background:#2b271f;border:1px solid #3d3626;color:#aaa;font-size:10px;padding:4px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;">Clear All</button></div></div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;"><button data-sns="quick-favs" type="button" title="Open Favs" style="background:#2b271f;border:1px solid #5b4a20;color:#facc15;font-size:10px;font-weight:bold;padding:4px 7px;border-radius:6px;cursor:pointer;white-space:nowrap;">★ Favs</button><button data-sns="manager" type="button" style="background:#f59e0b;border:none;color:#000;font-size:10px;font-weight:bold;padding:4px 8px;border-radius:6px;cursor:pointer;">⚙️ Manager</button></div>
        </div>
        <div style="flex:1;min-height:0;display:flex;overflow:hidden;"><div data-sns="categories" aria-label="Style categories" style="width:clamp(115px,20%,180px);flex:0 0 clamp(115px,20%,180px);min-height:0;overflow-y:auto;scrollbar-width:thin;background:#171510;border-right:1px solid #383328;padding:7px 5px;box-sizing:border-box;display:flex;flex-direction:column;gap:3px;"></div><div data-sns="gallery" style="flex:1;min-width:0;min-height:0;overflow-y:auto;scrollbar-gutter:stable;padding:8px;display:grid;grid-auto-rows:max-content;gap:8px;align-content:start;justify-content:start;box-sizing:border-box;"></div></div>`;

    const categoryList = container.querySelector('[data-sns="categories"]');
    const searchInput = container.querySelector('[data-sns="search"]');
    const searchClearButton = container.querySelector('[data-sns="search-clear"]');
    const selectedList = container.querySelector('[data-sns="selected-list"]');
    const gallery = container.querySelector('[data-sns="gallery"]');
    const managerButton = container.querySelector('[data-sns="manager"]');
    const quickFavsButton = container.querySelector('[data-sns="quick-favs"]');
    const toggleAllButton = container.querySelector('[data-sns="toggle-all"]');
    const toggleAllSlash = container.querySelector('[data-sns="toggle-all-slash"]');
    const clearButton = container.querySelector('[data-sns="clear"]');
    let currentCategory = "All";

    const updateQuickFavsButton = () => {
        const active = currentCategory === FAVORITES_CATEGORY;
        quickFavsButton.textContent = `★ Favs (${styleStore.favorites.size})`;
        quickFavsButton.style.background = active ? "#f59e0b" : "#2b271f";
        quickFavsButton.style.borderColor = active ? "#fbbf24" : "#5b4a20";
        quickFavsButton.style.color = active ? "#111" : "#facc15";
    };

    const syncGalleryColumns = () => {
        const computed = getComputedStyle(gallery);
        const horizontalPadding = parseFloat(computed.paddingLeft || "0") + parseFloat(computed.paddingRight || "0");
        const availableWidth = Math.max(1, gallery.clientWidth - horizontalPadding);
        const targetWidth = cardSizeStore.value;
        const minimumWidth = Math.max(MIN_CARD_SIZE * 0.875, Math.round(targetWidth * 0.875));
        let columns = Math.max(
            1,
            Math.floor((availableWidth + NODE_CARD_GAP) / (minimumWidth + NODE_CARD_GAP)),
        );
        let cardWidth = (availableWidth - NODE_CARD_GAP * (columns - 1)) / columns;
        while (columns > 1 && cardWidth < minimumWidth) {
            columns -= 1;
            cardWidth = (availableWidth - NODE_CARD_GAP * (columns - 1)) / columns;
        }
        cardWidth = Math.min(targetWidth, Math.max(1, Math.floor(cardWidth)));
        gallery.style.gridTemplateColumns = `repeat(${columns}, minmax(0, ${cardWidth}px))`;
    };
    const galleryResizeObserver = typeof ResizeObserver === "function"
        ? new ResizeObserver(syncGalleryColumns)
        : null;
    galleryResizeObserver?.observe(gallery);

    const stopInterference = (event) => event.stopPropagation();
    for (const eventName of ["wheel", "pointerdown", "mousedown", "mouseup", "touchstart", "touchmove", "click"]) {
        container.addEventListener(eventName, stopInterference, { passive: true });
    }

    let refreshSelectionUi = () => {};
    let syncExecutionSelection = () => {};
    const disabledStyleKeys = new Set();
    let domWidget;
    const hasNativeDomWidget = typeof node.addDOMWidget === "function";
    if (hasNativeDomWidget) {
        domWidget = node.addDOMWidget("style_gallery_widget", "dom", container, {
            getValue: () => node.properties.selected_styles || "",
            setValue: (value) => {
                const restoredValue = typeof value === "string" ? value : "";
                node.properties.selected_styles = restoredValue;
                disabledStyleKeys.clear();
                queueMicrotask(() => {
                    syncExecutionSelection();
                    refreshSelectionUi();
                });
            },
            getMinHeight: () => MIN_GALLERY_HEIGHT,
            serialize: false,
        });
    } else {
        domWidget = {
            name: "style_gallery_widget",
            type: "dom",
            element: container,
            draw() {},
        };
        node.widgets ||= [];
        node.widgets.push(domWidget);
    }

    if (!hasNativeDomWidget) {
        domWidget.computeSize = (width) => {
            const nodeHeight = Number(node.size?.[1]) || 520;
            const top = Number(domWidget.last_y) || 120;
            return [width || 460, Math.max(MIN_GALLERY_HEIGHT, nodeHeight - top - 12)];
        };
    }

    const syncHeight = () => {
        const nodeHeight = Number(node.size?.[1]) || 520;
        const top = Number(domWidget.last_y) || 120;
        container.style.height = `${Math.max(MIN_GALLERY_HEIGHT, nodeHeight - top - 12)}px`;
        syncGalleryColumns();
    };
    const originalResize = node.onResize;
    node.onResize = function () {
        const result = originalResize?.apply(this, arguments);
        syncHeight();
        requestAnimationFrame(syncHeight);
        return result;
    };

    const getSelection = () => parseSelection(node.properties.selected_styles || selectionWidget?.value || "");
    syncExecutionSelection = () => {
        if (!selectionWidget) return;
        selectionWidget.value = JSON.stringify(getSelection().filter(
            (item) => !disabledStyleKeys.has(selectionKey(item.category, item.name))
        ));
    };
    const saveSelection = (items) => {
        const value = JSON.stringify(items);
        node.properties.selected_styles = value;
        const selectedKeys = new Set(items.map((item) => selectionKey(item.category, item.name)));
        for (const key of disabledStyleKeys) {
            if (!selectedKeys.has(key)) disabledStyleKeys.delete(key);
        }
        syncExecutionSelection();
        setNodeDirty(node);
        renderSelectionTags();
        updateSelectionVisuals();
    };
    const selectedKeySet = () => new Set(getSelection().map((item) => selectionKey(item.category, item.name)));
    const updateToggleAllButton = (items) => {
        const anyEnabled = items.some((item) => !disabledStyleKeys.has(selectionKey(item.category, item.name)));
        const allEnabled = items.every((item) => !disabledStyleKeys.has(selectionKey(item.category, item.name)));
        toggleAllButton.disabled = items.length === 0;
        toggleAllButton.style.opacity = items.length ? "1" : ".55";
        toggleAllButton.title = anyEnabled ? "Disable all selected styles" : "Enable all selected styles";
        toggleAllButton.setAttribute("aria-label", toggleAllButton.title);
        toggleAllSlash.style.display = allEnabled ? "none" : "block";
    };

    const renderSelectionTags = () => {
        const items = getSelection();
        updateToggleAllButton(items);
        if (!items.length) {
            selectedList.replaceChildren(createElement("span", {
                text: "No styles selected",
                css: "color:#6b7280;font-size:9px;padding:0 3px;white-space:nowrap;",
            }));
            clearButton.disabled = true;
            clearButton.style.opacity = ".55";
            return;
        }

        const fragment = document.createDocumentFragment();
        items.forEach((item, index) => {
            const key = selectionKey(item.category, item.name);
            const enabled = !disabledStyleKeys.has(key);
            const tag = createElement("span", {
                title: item.category ? `${item.category} / ${item.name}` : item.name,
                css: `height:19px;max-width:150px;display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;background:#2a2210;border:1px solid #5b4a20;border-radius:5px;padding:0 3px;box-sizing:border-box;color:#f3f4f6;font-size:9px;opacity:${enabled ? "1" : ".55"};`,
            });
            const checkbox = createElement("input", {
                type: "checkbox",
                title: `${enabled ? "Disable" : "Enable"} ${item.name}`,
                css: "width:13px;height:13px;margin:0;flex:0 0 13px;cursor:pointer;accent-color:#f59e0b;",
            });
            checkbox.checked = enabled;
            checkbox.setAttribute("aria-label", `Enable ${item.name}`);
            checkbox.onpointerdown = (event) => event.stopPropagation();
            checkbox.onclick = (event) => event.stopPropagation();
            checkbox.onchange = () => {
                if (checkbox.checked) disabledStyleKeys.delete(key);
                else disabledStyleKeys.add(key);
                syncExecutionSelection();
                setNodeDirty(node);
                renderSelectionTags();
            };
            const label = createElement("span", {
                text: item.name,
                css: "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
            });
            const remove = createElement("button", {
                text: "×",
                title: `Remove ${item.name}`,
                type: "button",
                css: "width:14px;height:14px;display:flex;align-items:center;justify-content:center;flex:0 0 14px;background:transparent;border:0;color:#f59e0b;font-size:13px;line-height:1;padding:0;border-radius:3px;cursor:pointer;",
            });
            remove.setAttribute("aria-label", `Remove ${item.name}`);
            remove.onpointerdown = (event) => event.stopPropagation();
            remove.onclick = (event) => {
                event.stopPropagation();
                const current = getSelection();
                current.splice(index, 1);
                saveSelection(current);
            };
            tag.append(checkbox, label, remove);
            fragment.appendChild(tag);
        });
        selectedList.replaceChildren(fragment);
        clearButton.disabled = false;
        clearButton.style.opacity = "1";
    };

    const updateSelectionVisuals = () => {
        const selected = selectedKeySet();
        for (const card of gallery.querySelectorAll("[data-style-key]")) {
            let active = selected.has(card.dataset.styleKey);
            if (!active) {
                try {
                    const [, name] = JSON.parse(card.dataset.styleKey);
                    active = selected.has(selectionKey("", name));
                } catch (_) {
                    // Invalid card keys are treated as not selected.
                }
            }
            card.style.background = active ? "#2a2210" : "#1a1814";
            card.style.border = active ? "2px solid #f59e0b" : "1px solid #332e24";
            card.querySelector("[data-active-badge]").style.display = active ? "block" : "none";
            card.querySelector("[data-style-name]").style.color = active ? "#f59e0b" : "#f3f4f6";
        }
    };

    refreshSelectionUi = () => {
        renderSelectionTags();
        updateSelectionVisuals();
    };

    const syncRestoredSelection = () => {
        disabledStyleKeys.clear();
        const propertyValue = typeof node.properties?.selected_styles === "string"
            ? node.properties.selected_styles
            : "";
        const widgetValue = typeof selectionWidget?.value === "string"
            ? selectionWidget.value
            : "";
        const restoredValue = propertyValue || widgetValue;
        node.properties ||= {};
        node.properties.selected_styles = restoredValue;
        syncExecutionSelection();
        refreshSelectionUi();
    };

    const originalConfigure = node.onConfigure;
    node.onConfigure = function () {
        const result = originalConfigure?.apply(this, arguments);
        requestAnimationFrame(syncRestoredSelection);
        return result;
    };

    const renderCategoryList = (data = styleStore.data) => {
        const scrollTop = categoryList.scrollTop;
        const categories = Object.keys(data || {}).sort((left, right) => left.localeCompare(right));
        if (currentCategory !== "All" && currentCategory !== FAVORITES_CATEGORY && !categories.includes(currentCategory)) {
            currentCategory = "All";
        }
        const entries = [{ value: "All", label: "All Categories" }, ...categories.map((category) => ({
            value: category,
            label: category,
        }))];
        const fragment = document.createDocumentFragment();
        for (const entry of entries) {
            const active = currentCategory === entry.value;
            const count = entry.value === "All"
                ? categories.reduce((sum, category) => sum + (Array.isArray(data[category]) ? data[category].length : 0), 0)
                : Array.isArray(data[entry.value]) ? data[entry.value].length : 0;
            const button = createElement("button", {
                text: `📁 ${entry.label} (${count})`,
                type: "button",
                title: entry.label,
                css: `width:100%;min-height:25px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 6px;border-radius:5px;border:1px solid ${active ? "#a36a12" : "transparent"};background:${active ? "#3a2b12" : "transparent"};color:${active ? "#fbbf24" : "#c9c3b7"};font-size:10px;font-weight:${active ? "700" : "400"};cursor:pointer;flex:0 0 auto;`,
            });
            button.setAttribute("aria-pressed", String(active));
            button.onclick = (event) => {
                event.stopPropagation();
                currentCategory = entry.value;
                renderCategoryList();
                renderGallery();
            };
            fragment.appendChild(button);
        }
        categoryList.replaceChildren(fragment);
        categoryList.scrollTop = scrollTop;
        updateQuickFavsButton();
    };

    const renderGallery = (data = styleStore.data) => {
        const query = searchInput.value.trim().toLowerCase();
        const selectedCategory = currentCategory;
        const selected = selectedKeySet();
        const fragment = document.createDocumentFragment();
        let total = 0;

        const entries = !query && selectedCategory === FAVORITES_CATEGORY
            ? favoriteStyleEntries(data)
            : Object.keys(data || {})
                .sort((left, right) => left.localeCompare(right))
                .filter((category) => query || selectedCategory === "All" || selectedCategory === category)
                .flatMap((category) => Array.isArray(data[category])
                    ? data[category].map((style) => ({ category, style }))
                    : []);

        for (const { category, style } of entries.sort((left, right) =>
            String(left.style?.name || "").localeCompare(String(right.style?.name || "")))) {
                const name = String(style?.name || "");
                const localizedName = String(style?.name_cn || "");
                if (query && !name.toLowerCase().includes(query) && !localizedName.toLowerCase().includes(query)) continue;
                total += 1;
                const key = selectionKey(category, name);
                const active = selected.has(key) || selected.has(selectionKey("", name));
                const card = createElement("div", {
                    css: `min-width:0;background:${active ? "#2a2210" : "#1a1814"};border:${active ? "2px solid #f59e0b" : "1px solid #332e24"};border-radius:8px;overflow:hidden;cursor:pointer;display:flex;flex-direction:column;position:relative;box-sizing:border-box;`,
                    title: `${category} / ${name}`,
                });
                card.dataset.styleKey = key;
                const cover = createThumbnail(style, MAX_CARD_SIZE, true);
                const activeBadge = createElement("span", { text: "✓ Active", css: `position:absolute;top:3px;left:3px;background:#f59e0b;color:#000;font-size:9px;font-weight:bold;padding:1px 4px;border-radius:3px;display:${active ? "block" : "none"};` });
                activeBadge.dataset.activeBadge = "";
                const editButton = createElement("button", { text: "✏️", title: `Edit ${name}`, type: "button", css: "position:absolute;bottom:3px;left:3px;width:19px;height:18px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.85);border:1px solid #aaa;color:#fff;font-size:10px;line-height:1;padding:0;border-radius:4px;cursor:pointer;" });
                editButton.setAttribute("aria-label", `Edit ${name}`);
                const quickThumbnailButton = createElement("button", { text: "📷", title: `Use last generated image for ${name}`, type: "button", css: "position:absolute;bottom:24px;left:3px;width:19px;height:18px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.85);border:1px solid #a87824;color:#f59e0b;font-size:10px;line-height:1;padding:0;border-radius:4px;cursor:pointer;" });
                quickThumbnailButton.setAttribute("aria-label", `Use last generated image for ${name}`);
                const favoriteButton = createFavoriteButton(category, name, (error) => console.error("Cannot update favorite:", error));
                cover.append(activeBadge, favoriteButton, quickThumbnailButton, editButton);
                const nameElement = createElement("div", { text: name, css: `padding:3px 5px;font-size:9px;font-weight:bold;color:${active ? "#f59e0b" : "#f3f4f6"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` });
                nameElement.dataset.styleName = "";
                card.append(cover, nameElement);

                card.onclick = () => {
                    const current = getSelection();
                    const index = current.findIndex((item) => selectionKey(item.category, item.name) === key || (!item.category && item.name === name));
                    if (index >= 0) current.splice(index, 1);
                    else current.push({ category, name });
                    saveSelection(current);
                };
                editButton.onpointerdown = (event) => event.stopPropagation();
                editButton.onclick = (event) => {
                    event.stopPropagation();
                    showStyleManagerModal(node, { cat: category, style });
                };
                quickThumbnailButton.onpointerdown = (event) => event.stopPropagation();
                quickThumbnailButton.onclick = async (event) => {
                    event.stopPropagation();
                    const source = getLastGeneratedImage();
                    if (!source) {
                        alert("Generate an image first");
                        return;
                    }
                    if (!confirm(`Replace the preview for '${name}' with the last generated image?`)) {
                        return;
                    }
                    const previousIcon = quickThumbnailButton.textContent;
                    quickThumbnailButton.disabled = true;
                    quickThumbnailButton.textContent = "…";
                    try {
                        await replaceStyleThumbnail(category, style, source);
                        await styleStore.refresh();
                    } catch (error) {
                        alert(`Cannot update preview: ${error.message}`);
                        quickThumbnailButton.disabled = false;
                        quickThumbnailButton.textContent = previousIcon;
                    }
                };
                fragment.appendChild(card);
        }

        gallery.replaceChildren(fragment);
        if (!total) gallery.appendChild(createElement("div", { text: styleStore.loaded ? "No matching styles found" : "Loading styles...", css: "color:#888;font-size:11px;text-align:center;padding:20px;grid-column:1/-1;" }));
    };

    const onStoreUpdate = (data) => {
        renderCategoryList(data);
        renderGallery(data);
    };
    const unsubscribe = styleStore.subscribe(onStoreUpdate);
    const unsubscribeCardSize = cardSizeStore.subscribe(() => {
        syncGalleryColumns();
    });
    const unsubscribeFavorites = styleStore.subscribeFavorites(() => {
        updateQuickFavsButton();
        if (currentCategory === FAVORITES_CATEGORY) renderGallery();
        else refreshFavoriteButtons(gallery);
    });
    const originalRemoved = node.onRemoved;
    node.onRemoved = function () {
        unsubscribe();
        unsubscribeFavorites();
        unsubscribeCardSize();
        galleryResizeObserver?.disconnect();
        container.remove();
        return originalRemoved?.apply(this, arguments);
    };

    const updateSearchClearButton = () => {
        searchClearButton.style.display = searchInput.value ? "flex" : "none";
    };
    searchInput.oninput = () => {
        updateSearchClearButton();
        renderGallery();
    };
    searchClearButton.onclick = (event) => {
        event.stopPropagation();
        searchInput.value = "";
        updateSearchClearButton();
        searchInput.focus();
        renderGallery();
    };
    quickFavsButton.onclick = (event) => {
        event.stopPropagation();
        currentCategory = FAVORITES_CATEGORY;
        renderCategoryList();
        renderGallery();
    };
    clearButton.onclick = (event) => {
        event.stopPropagation();
        saveSelection([]);
    };
    toggleAllButton.onclick = (event) => {
        event.stopPropagation();
        const items = getSelection();
        if (!items.length) return;
        const anyEnabled = items.some((item) => !disabledStyleKeys.has(selectionKey(item.category, item.name)));
        if (anyEnabled) {
            for (const item of items) disabledStyleKeys.add(selectionKey(item.category, item.name));
        } else {
            disabledStyleKeys.clear();
        }
        syncExecutionSelection();
        setNodeDirty(node);
        renderSelectionTags();
    };
    managerButton.onclick = (event) => {
        event.stopPropagation();
        showStyleManagerModal(node);
    };

    renderCategoryList();
    if (styleStore.loaded) onStoreUpdate(styleStore.data);
    else {
        renderGallery();
        styleStore.refresh().catch((error) => {
            gallery.replaceChildren(createElement("div", { text: `Failed to load styles: ${error.message}`, css: "color:#ef4444;font-size:11px;text-align:center;padding:20px;grid-column:1/-1;" }));
        });
    }
    syncRestoredSelection();
    syncHeight();
}

app.registerExtension({
    name: "ComfyUI.StyleNodeStudio",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "StyleNodeStudio") return;
        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalCreated?.apply(this, arguments);
            setupStyleNodeWidget(this);
            return result;
        };
    },
    async nodeCreated(node) {
        const className = node.comfyClass || node.type || node.constructor?.type || "";
        if (className === "StyleNodeStudio") setupStyleNodeWidget(node);
    },
});
