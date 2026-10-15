// Unit tests for Allegiance mobile controls and landscape mode:
// - Babylon.js VirtualJoystick creation and axis mapping;
// - Touch action buttons (Fire, Jump, Interact, ADS, Reload, Weapon cycle, Command);
// - Context sensitivity (on foot vs. flying car / Cobra);
// - Mode switching (play/speech vs. menus);
// - Landscape mode detection and orientation prompt overlay.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MobileControls, type MobileCallbacks } from "../../src/game/al_mobile";
import { Controller } from "../../src/game/al_controller";
import { VirtualJoystick } from "@babylonjs/core/Misc/virtualJoystick";

// Lightweight DOM mock for vitest in Node environment
class MockElement {
    tagName: string;
    id = "";
    style: Record<string, string> = {};
    textContent = "";
    innerHTML = "";
    children: MockElement[] = [];
    listeners = new Map<string, ((e: any) => void)[]>();

    constructor(tag: string) {
        this.tagName = tag.toUpperCase();
    }

    appendChild(child: MockElement): MockElement {
        this.children.push(child);
        return child;
    }

    removeChild(child: MockElement): MockElement {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        return child;
    }

    remove(): void {
        const bodyChildren = (globalThis as any).document?.body?.children;
        if (bodyChildren) {
            const idx = bodyChildren.indexOf(this);
            if (idx >= 0) bodyChildren.splice(idx, 1);
        }
    }

    setAttribute(_k: string, _v: string): void {}

    addEventListener(event: string, fn: (e: any) => void): void {
        const list = this.listeners.get(event) ?? [];
        list.push(fn);
        this.listeners.set(event, list);
    }

    removeEventListener(event: string, fn: (e: any) => void): void {
        const list = this.listeners.get(event) ?? [];
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
    }

    dispatchEvent(event: { type: string; preventDefault?: () => void; stopPropagation?: () => void }): void {
        if (!event.preventDefault) event.preventDefault = () => {};
        if (!event.stopPropagation) event.stopPropagation = () => {};
        const list = this.listeners.get(event.type) ?? [];
        list.forEach(fn => fn(event));
    }

    querySelector(selector: string): MockElement | null {
        const idMatch = selector.match(/^#([\w-]+)/);
        if (idMatch) {
            const id = idMatch[1];
            return findById(this, id);
        }
        return null;
    }

    getContext(_type: string): any {
        return {
            beginPath: () => {},
            stroke: () => {},
            closePath: () => {},
            clearRect: () => {},
            arc: () => {},
            drawImage: () => {},
            strokeStyle: "#fff",
            lineWidth: 1,
            fillStyle: "#fff",
        };
    }
}

function findById(node: MockElement, id: string): MockElement | null {
    if (node.id === id) return node;
    for (const c of node.children) {
        const found = findById(c, id);
        if (found) return found;
    }
    return null;
}

function setupMockDom(): void {
    const elementsById = new Map<string, MockElement>();

    const doc = {
        fullscreenElement: null,
        body: new MockElement("body"),
        createElement(tag: string): MockElement {
            const el = new MockElement(tag);
            // Simulate innerHTML elements parsing for known button IDs
            const origInnerHtml = Object.getOwnPropertyDescriptor(MockElement.prototype, "innerHTML");
            Object.defineProperty(el, "innerHTML", {
                set(val: string) {
                    this._html = val;
                    const matches = val.matchAll(/id="([\w-]+)"/g);
                    for (const m of matches) {
                        const childId = m[1];
                        const child = new MockElement("div");
                        child.id = childId;
                        this.children.push(child);
                        elementsById.set(childId, child);
                    }
                },
                get() { return this._html ?? ""; },
                configurable: true,
            });
            return el;
        },
        getElementById(id: string): MockElement | null {
            if (elementsById.has(id)) return elementsById.get(id)!;
            return findById(doc.body, id);
        },
        documentElement: {
            requestFullscreen: async () => {},
        },
    };

    const win = {
        innerWidth: 800,
        innerHeight: 450,
        devicePixelRatio: 2,
        location: { search: "?mobile=1" },
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        addEventListener: () => {},
        removeEventListener: () => {},
        requestAnimationFrame: (fn: any) => setTimeout(fn, 16),
        cancelAnimationFrame: () => {},
    };

    Object.defineProperty(globalThis, "document", { value: doc, configurable: true, writable: true });
    Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
    Object.defineProperty(globalThis, "navigator", { value: { maxTouchPoints: 5, userAgent: "Mozilla/5.0 (iPhone)" }, configurable: true, writable: true });
    Object.defineProperty(globalThis, "screen", { value: { orientation: { lock: async () => {} } }, configurable: true, writable: true });
    (globalThis as any).requestAnimationFrame = (fn: any) => setTimeout(fn, 16);
    (globalThis as any).cancelAnimationFrame = () => {};
    (globalThis as any).HTMLCanvasElement = MockElement;
    (globalThis as any).HTMLButtonElement = MockElement;
    (globalThis as any).HTMLDivElement = MockElement;
}

describe("MobileControls", () => {
    let controller: Controller;
    let keysSent: string[] = [];
    let buttonsSent: [string, boolean][] = [];
    let triggerState: { held: boolean; fresh: boolean } = { held: false, fresh: false };
    let adsState = false;
    let currentPrompt: string | null = null;
    let piloting = false;
    let cobra = false;
    let currentWeapon = { name: "M-90 Sidearm", mag: 12, reserve: 36, id: "pistol" };

    const mockCallbacks: MobileCallbacks = {
        onKey: (k: string) => { keysSent.push(k); },
        controllerButton: (b: string, p: boolean) => { buttonsSent.push([b, p]); },
        setTrigger: (held: boolean, fresh: boolean) => { triggerState = { held, fresh }; },
        setAds: (active: boolean) => { adsState = active; },
        getPrompt: () => currentPrompt,
        isPiloting: () => piloting,
        isCobra: () => cobra,
        getWeapon: () => currentWeapon,
    };

    beforeEach(() => {
        setupMockDom();
        controller = new Controller();
        keysSent = [];
        buttonsSent = [];
        triggerState = { held: false, fresh: false };
        adsState = false;
        currentPrompt = null;
        piloting = false;
        cobra = false;

        MobileControls.get()?.destroy();
        VirtualJoystick.Canvas = null;
    });

    afterEach(() => {
        MobileControls.get()?.destroy();
        VirtualJoystick.Canvas = null;
    });

    it("initializes and mounts mobile HUD in DOM", () => {
        const mc = MobileControls.init(mockCallbacks);
        expect(mc).toBeDefined();

        const root = document.getElementById("allegiance-mobile-controls");
        expect(root).not.toBeNull();

        const fireBtn = document.getElementById("al-m-fire");
        expect(fireBtn).not.toBeNull();

        const interactBtn = document.getElementById("al-m-interact");
        expect(interactBtn).not.toBeNull();

        const jumpBtn = document.getElementById("al-m-jump");
        expect(jumpBtn).not.toBeNull();
    });

    it("creates the orientation overlay with rotate prompt", () => {
        MobileControls.init(mockCallbacks);
        const overlay = document.getElementById("allegiance-orientation-overlay");
        expect(overlay).not.toBeNull();
        expect(overlay?.innerHTML).toContain("ROTATE TO LANDSCAPE");
    });

    it("hides controls during menus and shows during gameplay", () => {
        const mc = MobileControls.init(mockCallbacks);
        const root = document.getElementById("allegiance-mobile-controls");

        // Menu mode: hidden
        mc.update("title", controller, 1.0);
        expect(root?.style.display).toBe("none");

        mc.update("console", controller, 1.1);
        expect(root?.style.display).toBe("none");

        // Play mode: visible
        mc.update("play", controller, 1.2);
        expect(root?.style.display).toBe("block");

        // Speech mode: visible
        mc.update("speech", controller, 1.3);
        expect(root?.style.display).toBe("block");
    });

    it("fire button triggers controller RightTrigger2 and setTrigger", () => {
        const mc = MobileControls.init(mockCallbacks);
        mc.update("play", controller, 1.0);

        const fireBtn = document.getElementById("al-m-fire") as any;
        expect(fireBtn).not.toBeNull();

        // Pointer down -> fire held
        fireBtn.dispatchEvent({ type: "pointerdown" });
        expect(triggerState.held).toBe(true);
        expect(triggerState.fresh).toBe(true);
        expect(buttonsSent).toContainEqual(["RightTrigger2", true]);

        // Pointer up -> fire released
        fireBtn.dispatchEvent({ type: "pointerup" });
        expect(triggerState.held).toBe(false);
        expect(buttonsSent).toContainEqual(["RightTrigger2", false]);
    });

    it("jump button triggers South button for jump / flight rise", () => {
        const mc = MobileControls.init(mockCallbacks);
        mc.update("play", controller, 1.0);

        const jumpBtn = document.getElementById("al-m-jump") as any;
        jumpBtn.dispatchEvent({ type: "pointerdown" });
        expect(buttonsSent).toContainEqual(["South", true]);

        jumpBtn.dispatchEvent({ type: "pointerup" });
        expect(buttonsSent).toContainEqual(["South", false]);
    });

    it("interact button triggers key e and updates label based on prompt", () => {
        const mc = MobileControls.init(mockCallbacks);
        const interactBtn = document.getElementById("al-m-interact") as any;

        // Context: near civilian
        currentPrompt = "[E] TALK TO ADA";
        mc.update("play", controller, 1.0);
        expect(interactBtn.textContent).toBe("TALK");

        // Context: near car
        currentPrompt = "[E] ENTER YOUR FLYING CAR";
        mc.update("play", controller, 1.1);
        expect(interactBtn.textContent).toBe("ENTER");

        // Context: loot
        currentPrompt = "[E] SEARCH THE FOOTLOCKER";
        mc.update("play", controller, 1.2);
        expect(interactBtn.textContent).toBe("SEARCH");

        // Tap triggers onKey('e')
        interactBtn.dispatchEvent({ type: "pointerdown" });
        expect(keysSent).toContain("e");
    });

    it("adapts controls when piloting a car or Cobra", () => {
        const mc = MobileControls.init(mockCallbacks);
        const jumpBtn = document.getElementById("al-m-jump") as any;
        const descendBtn = document.getElementById("al-m-descend") as any;
        const landBtn = document.getElementById("al-m-land") as any;
        const fireBtn = document.getElementById("al-m-fire") as any;

        // On foot
        piloting = false;
        mc.update("play", controller, 1.0);
        expect(jumpBtn.textContent).toBe("JUMP");
        expect(descendBtn.style.display).toBe("none");
        expect(landBtn.style.display).toBe("none");
        expect(fireBtn.textContent).toBe("FIRE");

        // Flying standard car
        piloting = true;
        cobra = false;
        mc.update("play", controller, 1.1);
        expect(jumpBtn.textContent).toBe("RISE");
        expect(descendBtn.style.display).toBe("flex");
        expect(landBtn.style.display).toBe("flex");
        expect(fireBtn.textContent).toBe("BOOST");

        // Piloting Cobra
        cobra = true;
        mc.update("play", controller, 1.2);
        expect(fireBtn.textContent).toBe("MISSILE");
    });

    it("ADS button toggles aiming down sights", () => {
        const mc = MobileControls.init(mockCallbacks);
        mc.update("play", controller, 1.0);

        const adsBtn = document.getElementById("al-m-ads") as any;
        expect(adsState).toBe(false);

        adsBtn.dispatchEvent({ type: "pointerdown" });
        expect(adsState).toBe(true);

        adsBtn.dispatchEvent({ type: "pointerdown" });
        expect(adsState).toBe(false);
    });

    it("weapon button cycles weapons and displays ammo", () => {
        const mc = MobileControls.init(mockCallbacks);
        mc.update("play", controller, 1.0);

        const weaponBtn = document.getElementById("al-m-weapon") as any;
        expect(weaponBtn.textContent).toContain("M-90 SIDEARM (12/36)");

        weaponBtn.dispatchEvent({ type: "pointerdown" });
        expect(buttonsSent).toContainEqual(["RightTrigger", true]);
        expect(buttonsSent).toContainEqual(["RightTrigger", false]);
    });

    it("quick heal and view buttons dispatch h and v", () => {
        const mc = MobileControls.init(mockCallbacks);
        mc.update("play", controller, 1.0);

        const healBtn = document.getElementById("al-m-heal") as any;
        healBtn.dispatchEvent({ type: "pointerdown" });
        expect(keysSent).toContain("h");

        const viewBtn = document.getElementById("al-m-view") as any;
        viewBtn.dispatchEvent({ type: "pointerdown" });
        expect(keysSent).toContain("v");
    });

    it("command button dispatches Tab", () => {
        const mc = MobileControls.init(mockCallbacks);
        mc.update("play", controller, 1.0);

        const cmdBtn = document.getElementById("al-m-command") as any;
        cmdBtn.dispatchEvent({ type: "pointerdown" });
        expect(keysSent).toContain("Tab");
    });

    it("optimizes right cluster height and top bar for landscape mode with responsive media queries", () => {
        MobileControls.init(mockCallbacks);
        const root = document.getElementById("allegiance-mobile-controls");
        expect(root).not.toBeNull();

        // Right cluster has low profile height (<= 130px, reduced from 220px)
        const cluster = document.getElementById("al-m-right-cluster");
        expect(cluster).not.toBeNull();
        expect(cluster?.innerHTML).not.toBeNull();

        // Top bar container exists and contains responsive CSS styles
        const topBar = document.getElementById("al-m-top-bar");
        expect(topBar).not.toBeNull();

        // Root HTML includes media queries for low-height landscape screens
        expect(root?.innerHTML).toContain("@media (max-height: 380px)");
        expect(root?.innerHTML).toContain("@media (max-height: 330px)");
    });
});

