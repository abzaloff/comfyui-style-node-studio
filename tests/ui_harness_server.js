const http = require("http");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const styles = {
    "3D Render": [
        { name: "Low Poly 3D", prompt: "low poly, {prompt}", negative_prompt: "photo", thumbnail: "" },
        { name: "Pixar Animation 3D", prompt: "animation, {prompt}", negative_prompt: "flat", thumbnail: "" },
    ],
    Photography: [
        { name: "35mm Photography", prompt: "35mm film, {prompt}", negative_prompt: "cgi", thumbnail: "" },
        { name: "Film Noir", prompt: "film noir, {prompt}", negative_prompt: "colorful", thumbnail: "" },
    ],
    "Digital Painting": [
        { name: "Watercolor Painting", prompt: "watercolor, {prompt}", negative_prompt: "photo", thumbnail: "" },
    ],
};
const favorites = [{ category: "Photography", name: "Film Noir" }];
let authenticatedViewRequests = 0;
let thumbnailSaveRequests = 0;

function send(response, status, contentType, body) {
    response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
    response.end(body);
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
            } catch (error) {
                reject(error);
            }
        });
        request.on("error", reject);
    });
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1:8099");
    if (url.pathname === "/") {
        send(response, 200, "text/html; charset=utf-8", `<!doctype html>
            <html><head><meta charset="utf-8"><title>Style Node Studio UI QA</title>
            <style>html,body{margin:0;min-height:100%;background:#050505;color:#fff}</style></head>
            <body><script type="module">
                localStorage.setItem(
                    "comfyui_style_node_last_generated_img",
                    "/api/view?filename=generated.png&subfolder=&type=output",
                );
                await import("/web/js/style_node_studio.js");
                if (new URLSearchParams(location.search).get("mode") === "node") {
                    const width = Number(new URLSearchParams(location.search).get("width")) || 760;
                    const host = document.createElement("div");
                    host.id = "node-host";
                    host.style.cssText = "width:" + width + "px;height:520px;margin:20px;background:#121820;padding:8px;box-sizing:border-box;";
                    document.body.appendChild(host);
                    class FakeNodeType {}
                    await window.__snsExtension.beforeRegisterNodeDef(FakeNodeType, { name: "StyleNodeStudio" });
                    const node = new FakeNodeType();
                    node.size = [width, 520];
                    node.properties = {};
                    node.widgets = [
                        { name: "category", value: "All Categories" },
                        { name: "selected_styles", value: "" },
                    ];
                    node.addDOMWidget = (name, type, element, options) => {
                        host.appendChild(element);
                        return { name, type, element, options, last_y: 110 };
                    };
                    node.setDirtyCanvas = () => {};
                    node.onNodeCreated();
                } else {
                    window.showStyleManagerModal({});
                }
            </script></body></html>`);
        return;
    }
    if (url.pathname === "/web/js/style_node_studio.js") {
        send(response, 200, "text/javascript; charset=utf-8", fs.readFileSync(path.join(projectRoot, "web/js/style_node_studio.js")));
        return;
    }
    if (url.pathname === "/scripts/app.js") {
        send(response, 200, "text/javascript; charset=utf-8", "export const app={registerExtension(extension){window.__snsExtension=extension;}};");
        return;
    }
    if (url.pathname === "/scripts/api.js") {
        send(response, 200, "text/javascript; charset=utf-8", `
            export const api={
                addEventListener(){},
                apiURL(value){return "/api"+value;},
                fetchApi(value,options={}){
                    const headers=new Headers(options.headers||{});
                    headers.set("X-Comfy-Api","1");
                    return fetch("/api"+value,{...options,headers});
                }
            };
        `);
        return;
    }
    if (url.pathname === "/api/view") {
        if (request.headers["x-comfy-api"] !== "1") {
            send(response, 401, "text/plain; charset=utf-8", "Use api.fetchApi");
            return;
        }
        authenticatedViewRequests += 1;
        send(response, 200, "image/png", fs.readFileSync(path.join(projectRoot, "assets/style-node-studio.png")));
        return;
    }
    if (url.pathname === "/style_node_studio/api/get_styles") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({ styles, favorites, errors: [] }));
        return;
    }
    if (url.pathname === "/style_node_studio/api/set_favorite" && request.method === "POST") {
        const body = await readJsonBody(request);
        const index = favorites.findIndex((item) => item.category === body.category && item.name === body.name);
        if (index >= 0) favorites.splice(index, 1);
        if (body.favorite) favorites.push({ category: body.category, name: body.name });
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({ status: "ok", ...body }));
        return;
    }
    if (url.pathname === "/style_node_studio/api/save_thumbnail" && request.method === "POST") {
        thumbnailSaveRequests += 1;
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({
            status: "ok",
            thumbnail: "/style_node_studio/api/thumbnail?category=Generated&filename=Generated%20Preview.webp",
        }));
        return;
    }
    if (url.pathname === "/style_node_studio/api/save_style" && request.method === "POST") {
        const body = await readJsonBody(request);
        styles[body.category] ||= [];
        styles[body.category] = styles[body.category].filter((style) => style.name !== body.style.name);
        styles[body.category].push(body.style);
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({ status: "ok", ...body }));
        return;
    }
    if (url.pathname === "/style_node_studio/api/thumbnail") {
        send(response, 200, "image/png", fs.readFileSync(path.join(projectRoot, "assets/style-node-studio.png")));
        return;
    }
    if (url.pathname === "/test-state") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({
            authenticatedViewRequests,
            thumbnailSaveRequests,
        }));
        return;
    }
    send(response, 404, "text/plain; charset=utf-8", "Not found");
});

server.listen(8099, "127.0.0.1", () => {
    console.log("Style Node Studio UI harness: http://127.0.0.1:8099/");
});
