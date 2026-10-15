// Mobile controls and landscape view manager for Allegiance:
// - Babylon.js VirtualJoystick for left-stick movement and right-stick aim/look;
// - Touch action buttons (Fire, Jump, Interact, ADS, Reload, Command, Weapon switch, Land, Descend);
// - Landscape mode enforcement overlay and fullscreen toggle;
// - Safe area insets and ergonomic thumb placement for mobile devices.

import { VirtualJoystick } from "@babylonjs/core/Misc/virtualJoystick";
import type { Controller } from "./al_controller";
import type { Mode } from "./al_screens";

export interface MobileCallbacks {
    onKey(key: string): void;
    controllerButton(button: string, pressed: boolean): void;
    setTrigger(held: boolean, fresh: boolean): void;
    setAds(active: boolean): void;
    getPrompt(): string | null;
    isPiloting(): boolean;
    isCobra(): boolean;
    getWeapon(): { name: string; mag: number; reserve: number; id: string };
    getUi?(): { click(x: number, y: number): string | null } | null;
    onTabSwitch?(tab: string): void;
}

export class MobileControls {
    private static instance: MobileControls | null = null;

    private leftStick: VirtualJoystick | null = null;
    private rightStick: VirtualJoystick | null = null;
    private root: HTMLDivElement | null = null;
    private orientationPrompt: HTMLDivElement | null = null;
    private fullscreenBtn: HTMLButtonElement | null = null;

    // Action buttons in the DOM
    private fireBtn: HTMLButtonElement | null = null;
    private interactBtn: HTMLButtonElement | null = null;
    private jumpBtn: HTMLButtonElement | null = null;
    private descendBtn: HTMLButtonElement | null = null;
    private landBtn: HTMLButtonElement | null = null;
    private adsBtn: HTMLButtonElement | null = null;
    private reloadBtn: HTMLButtonElement | null = null;
    private commandBtn: HTMLButtonElement | null = null;
    private weaponBtn: HTMLButtonElement | null = null;
    private healBtn: HTMLButtonElement | null = null;
    private viewBtn: HTMLButtonElement | null = null;

    private adsActive = false;
    private isTouchDevice = false;
    private ignoreOrientation = false;
    private currentMode: Mode = "title";

    private constructor(private cb: MobileCallbacks) {
        this.detectTouch();
        this.createOrientationOverlay();
        this.createMobileHud();
        this.setupOrientationListener();
    }

    static init(cb: MobileCallbacks): MobileControls {
        if (!MobileControls.instance) {
            MobileControls.instance = new MobileControls(cb);
        }
        return MobileControls.instance;
    }

    static get(): MobileControls | null {
        return MobileControls.instance;
    }

    private detectTouch(): void {
        if (typeof window === "undefined") {
            this.isTouchDevice = false;
            return;
        }
        const search = window.location?.search ?? "";
        const query = new URLSearchParams(search);
        if (query.has("mobile") || query.has("touch")) {
            this.isTouchDevice = true;
            return;
        }
        if (query.has("desktop") || query.has("nomobile")) {
            this.isTouchDevice = false;
            return;
        }

        const nav = typeof navigator !== "undefined" ? navigator : null;
        const ua = nav?.userAgent ?? "";
        const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) ||
            (nav?.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);
        const hasTouch = "ontouchstart" in window || ((nav?.maxTouchPoints ?? 0) > 0);
        const isCoarseTouchOnly = typeof window.matchMedia === "function" &&
            window.matchMedia("(hover: none) and (pointer: coarse)").matches;

        // Active only on mobile user-agents or pure coarse touch screens (tablets/phones)
        this.isTouchDevice = !!(hasTouch && (isMobileUA || isCoarseTouchOnly));
    }

    public isMobile(): boolean {
        return this.isTouchDevice;
    }

    public setMobile(active: boolean): void {
        this.isTouchDevice = active;
        if (!active) {
            if (this.root) this.root.style.display = "none";
            if (this.orientationPrompt) this.orientationPrompt.style.display = "none";
            if (VirtualJoystick.Canvas) VirtualJoystick.Canvas.style.display = "none";
        } else {
            this.checkOrientation();
        }
    }

    /**
     * Initializes the Babylon VirtualJoystick instances.
     */
    private initJoysticks(): void {
        if (!this.isTouchDevice) return;
        if (this.leftStick && this.rightStick) return;
        try {
            // Left virtual joystick for movement (gold theme color, compact for mobile landscape)
            this.leftStick = new VirtualJoystick(true, {
                color: "#ffc83b",
                containerSize: 50,
                puckSize: 25,
                limitToContainer: true,
            });

            // Right virtual joystick for looking/aiming (neutral translucent white)
            this.rightStick = new VirtualJoystick(false, {
                color: "rgba(255, 255, 255, 0.45)",
                containerSize: 50,
                puckSize: 25,
                limitToContainer: true,
            });

            // Style the Babylon joystick canvas and route UI clicks
            if (VirtualJoystick.Canvas) {
                VirtualJoystick.Canvas.style.zIndex = "5";
                VirtualJoystick.Canvas.id = "babylon-virtual-joystick-canvas";
                VirtualJoystick.Canvas.addEventListener("pointerdown", e => {
                    const ui = this.cb.getUi?.();
                    if (ui) {
                        const hit = ui.click(e.clientX, e.clientY);
                        if (hit) {
                            e.stopPropagation();
                            e.preventDefault();
                        }
                    }
                }, true);
            }
        } catch (e) {
            console.warn("[allegiance] VirtualJoystick initialization deferred:", e);
        }
    }

    /**
     * Creates the full-screen prompt asking the user to rotate to landscape mode.
     */
    private createOrientationOverlay(): void {
        if (typeof document === "undefined") return;
        const overlay = document.createElement("div");
        overlay.id = "allegiance-orientation-overlay";
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(12, 10, 10, 0.96);
            z-index: 1000;
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 24px;
            text-align: center;
            color: #ebdcb8;
            font-family: Play, sans-serif;
            box-sizing: border-box;
            user-select: none;
            -webkit-user-select: none;
        `;

        overlay.innerHTML = `
            <div style="width: 80px; height: 80px; margin-bottom: 20px; animation: al-rotate-phone 2s ease-in-out infinite;">
                <svg viewBox="0 0 64 64" fill="none" stroke="#ffc83b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%">
                    <!-- Phone shape -->
                    <rect x="18" y="10" width="28" height="44" rx="4" stroke="#ffc83b"/>
                    <line x1="28" y1="14" x2="36" y2="14" />
                    <circle cx="32" cy="48" r="1.5" fill="#ffc83b" />
                    <!-- Rotation arrow -->
                    <path d="M 50 20 A 24 24 0 0 1 50 44" stroke="#c41a1f" stroke-width="3" stroke-dasharray="3 3"/>
                    <polyline points="46,44 52,47 54,41" fill="#c41a1f"/>
                </svg>
            </div>
            <style>
                @keyframes al-rotate-phone {
                    0% { transform: rotate(0deg); }
                    50% { transform: rotate(-90deg); }
                    100% { transform: rotate(-90deg); }
                }
            </style>
            <h2 style="font: 26px Bungee, sans-serif; color: #c41a1f; margin: 0 0 10px 0; letter-spacing: 1px;">ROTATE TO LANDSCAPE</h2>
            <p style="font-size: 16px; line-height: 1.4; max-width: 380px; margin: 0 0 24px 0; color: #f5ead0;">
                Allegiance is designed for full landscape control. Turn your device horizontally for tactical vision and dual-stick play.
            </p>
            <div style="display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 280px;">
                <button id="al-btn-fullscreen-rotate" style="
                    font: 16px Bungee, sans-serif;
                    padding: 14px 20px;
                    background: #c41a1f;
                    color: #fff8e6;
                    border: 2px solid #ffc83b;
                    border-radius: 4px;
                    cursor: pointer;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                ">PLAY FULLSCREEN</button>
                <button id="al-btn-ignore-portrait" style="
                    font: 13px Play, sans-serif;
                    padding: 8px 12px;
                    background: transparent;
                    color: #999;
                    border: none;
                    text-decoration: underline;
                    cursor: pointer;
                ">Continue in portrait anyway</button>
            </div>
        `;

        document.body.appendChild(overlay);
        this.orientationPrompt = overlay;

        const fsBtn = overlay.querySelector("#al-btn-fullscreen-rotate");
        fsBtn?.addEventListener("click", () => {
            this.requestFullscreenAndLockLandscape();
        });

        const ignoreBtn = overlay.querySelector("#al-btn-ignore-portrait");
        ignoreBtn?.addEventListener("click", () => {
            this.ignoreOrientation = true;
            this.checkOrientation();
        });
    }

    /**
     * Creates the touch action buttons and HUD overlays for mobile devices.
     * Optimized for mobile landscape mode with low-profile thumb arcs and responsive scaling.
     */
    private createMobileHud(): void {
        if (typeof document === "undefined") return;

        const root = document.createElement("div");
        root.id = "allegiance-mobile-controls";
        root.style.cssText = `
            position: fixed;
            inset: 0;
            pointer-events: none;
            z-index: 20;
            display: none;
            user-select: none;
            -webkit-user-select: none;
            touch-action: none;
            box-sizing: border-box;
        `;

        // Inner HTML with right cluster buttons, top bar, responsive landscape styles and helpers
        root.innerHTML = `
            <style>
                #allegiance-mobile-controls * {
                    box-sizing: border-box;
                    -webkit-tap-highlight-color: transparent;
                }
                #al-m-top-bar {
                    position: absolute;
                    top: max(6px, env(safe-area-inset-top));
                    left: max(10px, env(safe-area-inset-left));
                    right: max(10px, env(safe-area-inset-right));
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    pointer-events: none;
                    z-index: 25;
                }
                #al-m-left-hint {
                    position: absolute;
                    bottom: max(14px, env(safe-area-inset-bottom));
                    left: max(16px, env(safe-area-inset-left));
                    width: 100px;
                    height: 100px;
                    border: 2px dashed rgba(255, 200, 59, 0.25);
                    border-radius: 50%;
                    pointer-events: none;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: rgba(255, 200, 59, 0.35);
                    font: 10px Bungee, sans-serif;
                }
                #al-m-right-cluster {
                    position: absolute;
                    bottom: max(8px, env(safe-area-inset-bottom));
                    right: max(10px, env(safe-area-inset-right));
                    width: 240px;
                    height: 122px;
                    pointer-events: none;
                }
                #al-m-right-cluster button {
                    pointer-events: auto;
                    touch-action: none;
                    outline: none;
                }
                #al-m-top-bar button {
                    pointer-events: auto;
                    touch-action: none;
                    outline: none;
                    height: 28px;
                }
                /* Compact landscape mode for low-height mobile devices (e.g. <= 380px) */
                @media (max-height: 380px) {
                    #al-m-top-bar {
                        top: max(4px, env(safe-area-inset-top));
                    }
                    #al-m-top-bar button {
                        height: 24px !important;
                        font-size: 9px !important;
                        padding: 0 6px !important;
                    }
                    #al-m-weapon {
                        max-width: 130px !important;
                    }
                    #al-m-left-hint {
                        width: 84px !important;
                        height: 84px !important;
                        font-size: 9px !important;
                        bottom: max(8px, env(safe-area-inset-bottom)) !important;
                        left: max(10px, env(safe-area-inset-left)) !important;
                    }
                    #al-m-right-cluster {
                        width: 215px !important;
                        height: 108px !important;
                        bottom: max(4px, env(safe-area-inset-bottom)) !important;
                        right: max(6px, env(safe-area-inset-right)) !important;
                    }
                    #al-m-fire {
                        width: 54px !important;
                        height: 54px !important;
                        font-size: 11px !important;
                        bottom: 2px !important;
                        right: 2px !important;
                    }
                    #al-m-jump {
                        width: 42px !important;
                        height: 42px !important;
                        font-size: 10px !important;
                        bottom: 6px !important;
                        right: 64px !important;
                    }
                    #al-m-reload, #al-m-descend {
                        width: 38px !important;
                        height: 38px !important;
                        font-size: 8px !important;
                        bottom: 8px !important;
                        right: 112px !important;
                    }
                    #al-m-interact {
                        height: 38px !important;
                        min-width: 48px !important;
                        font-size: 10px !important;
                        bottom: 60px !important;
                        right: 4px !important;
                    }
                    #al-m-ads {
                        width: 38px !important;
                        height: 38px !important;
                        font-size: 9px !important;
                        bottom: 54px !important;
                        right: 64px !important;
                    }
                    #al-m-land {
                        width: 38px !important;
                        height: 38px !important;
                        font-size: 8px !important;
                        bottom: 52px !important;
                        right: 112px !important;
                    }
                }
                /* Ultra-compact landscape mode for phones with browser chrome (height <= 330px) */
                @media (max-height: 330px) {
                    #al-m-right-cluster {
                        width: 195px !important;
                        height: 96px !important;
                    }
                    #al-m-fire {
                        width: 48px !important;
                        height: 48px !important;
                        font-size: 10px !important;
                    }
                    #al-m-jump {
                        width: 36px !important;
                        height: 36px !important;
                        font-size: 9px !important;
                        right: 56px !important;
                    }
                    #al-m-reload, #al-m-descend {
                        width: 34px !important;
                        height: 34px !important;
                        right: 98px !important;
                    }
                    #al-m-interact {
                        height: 32px !important;
                        min-width: 42px !important;
                        font-size: 9px !important;
                        bottom: 52px !important;
                    }
                    #al-m-ads {
                        width: 32px !important;
                        height: 32px !important;
                        bottom: 46px !important;
                        right: 56px !important;
                    }
                    #al-m-land {
                        width: 32px !important;
                        height: 32px !important;
                        bottom: 44px !important;
                        right: 98px !important;
                    }
                }
            </style>

            <!-- Top bar quick actions: streamlined, low-profile horizontal bar -->
            <div id="al-m-top-bar" style="
                position: absolute;
                top: max(6px, env(safe-area-inset-top));
                left: max(10px, env(safe-area-inset-left));
                right: max(10px, env(safe-area-inset-right));
                display: flex;
                justify-content: space-between;
                align-items: center;
                pointer-events: none;
            ">
                <!-- Left top: Command & Heal -->
                <div style="display: flex; gap: 6px; pointer-events: auto;">
                    <button id="al-m-command" style="
                        background: #110e0e;
                        color: #ffc83b;
                        border: 1.5px solid #ffc83b;
                        border-radius: 4px;
                        font: 11px Bungee, sans-serif;
                        height: 28px;
                        padding: 0 10px;
                        cursor: pointer;
                        box-shadow: 0 2px 6px rgba(0,0,0,0.6);
                        white-space: nowrap;
                    ">COMMAND</button>
                    <button id="al-m-heal" style="
                        background: #110e0e;
                        color: #4ade80;
                        border: 1.5px solid #4ade80;
                        border-radius: 4px;
                        font: 11px Bungee, sans-serif;
                        height: 28px;
                        padding: 0 8px;
                        cursor: pointer;
                        box-shadow: 0 2px 6px rgba(0,0,0,0.6);
                        white-space: nowrap;
                    ">+ HEAL</button>
                </div>

                <!-- Right top: Weapon, View, Fullscreen -->
                <div style="display: flex; gap: 6px; align-items: center; pointer-events: auto;">
                    <button id="al-m-weapon" style="
                        background: #1a1616;
                        color: #ebdcb8;
                        border: 1.5px solid #666;
                        border-radius: 4px;
                        font: 11px Play, sans-serif;
                        font-weight: bold;
                        height: 28px;
                        padding: 0 8px;
                        cursor: pointer;
                        white-space: nowrap;
                        max-width: 170px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                    ">WEAPON ⟳</button>
                    <button id="al-m-view" style="
                        background: #110e0e;
                        color: #ebdcb8;
                        border: 1.5px solid #666;
                        border-radius: 4px;
                        font: 11px Bungee, sans-serif;
                        height: 28px;
                        padding: 0 8px;
                        cursor: pointer;
                        white-space: nowrap;
                    ">1P/3P</button>
                    <button id="al-m-fullscreen" style="
                        background: #110e0e;
                        color: #ffc83b;
                        border: 1.5px solid #ffc83b;
                        border-radius: 4px;
                        font: 13px sans-serif;
                        height: 28px;
                        width: 30px;
                        padding: 0;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        cursor: pointer;
                    ">⛶</button>
                </div>
            </div>

            <!-- Left thumb zone hint -->
            <div id="al-m-left-hint" style="
                position: absolute;
                bottom: max(14px, env(safe-area-inset-bottom));
                left: max(16px, env(safe-area-inset-left));
                width: 100px;
                height: 100px;
                border: 2px dashed rgba(255, 200, 59, 0.25);
                border-radius: 50%;
                pointer-events: none;
                display: flex;
                align-items: center;
                justify-content: center;
                color: rgba(255, 200, 59, 0.35);
                font: 10px Bungee, sans-serif;
            ">MOVE</div>

            <!-- Right thumb action buttons cluster: ergonomic low-profile thumb arc -->
            <div id="al-m-right-cluster" style="
                position: absolute;
                bottom: max(8px, env(safe-area-inset-bottom));
                right: max(10px, env(safe-area-inset-right));
                width: 240px;
                height: 122px;
                pointer-events: none;
            ">
                <!-- Fire button (Primary, bottom-right) -->
                <button id="al-m-fire" style="
                    position: absolute;
                    bottom: 4px;
                    right: 4px;
                    width: 62px;
                    height: 62px;
                    border-radius: 50%;
                    background: radial-gradient(circle, #e62229 0%, #8f0d11 100%);
                    color: #fff8e6;
                    border: 2.5px solid #ffc83b;
                    font: 13px Bungee, sans-serif;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    pointer-events: auto;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.6);
                    outline: none;
                ">FIRE</button>

                <!-- Interact / Contextual button (Above Fire along thumb arc) -->
                <button id="al-m-interact" style="
                    position: absolute;
                    bottom: 72px;
                    right: 6px;
                    min-width: 56px;
                    height: 42px;
                    border-radius: 21px;
                    padding: 0 10px;
                    background: #1b2636;
                    color: #ffc83b;
                    border: 2px solid #ffc83b;
                    font: 11px Bungee, sans-serif;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    pointer-events: auto;
                    box-shadow: 0 3px 8px rgba(0,0,0,0.5);
                    outline: none;
                    white-space: nowrap;
                ">USE</button>

                <!-- Jump / Rise button (Left of Fire along bottom row) -->
                <button id="al-m-jump" style="
                    position: absolute;
                    bottom: 8px;
                    right: 74px;
                    width: 48px;
                    height: 48px;
                    border-radius: 50%;
                    background: #1f1b1b;
                    color: #f5ead0;
                    border: 2px solid #ebdcb8;
                    font: 11px Bungee, sans-serif;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    pointer-events: auto;
                    box-shadow: 0 3px 8px rgba(0,0,0,0.5);
                    outline: none;
                ">JUMP</button>

                <!-- ADS button (Above Jump along thumb arc) -->
                <button id="al-m-ads" style="
                    position: absolute;
                    bottom: 62px;
                    right: 72px;
                    width: 42px;
                    height: 42px;
                    border-radius: 50%;
                    background: #161414;
                    color: #ebdcb8;
                    border: 2px solid #888;
                    font: 10px Bungee, sans-serif;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    pointer-events: auto;
                    outline: none;
                ">ADS</button>

                <!-- Reload button (Left of Jump along bottom row) -->
                <button id="al-m-reload" style="
                    position: absolute;
                    bottom: 10px;
                    right: 130px;
                    width: 42px;
                    height: 42px;
                    border-radius: 50%;
                    background: #161414;
                    color: #cbd5e1;
                    border: 2px solid #666;
                    font: 9px Bungee, sans-serif;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    pointer-events: auto;
                    outline: none;
                ">RELOAD</button>

                <!-- Flight specific: Descend (replaces Reload spot) -->
                <button id="al-m-descend" style="
                    position: absolute;
                    bottom: 10px;
                    right: 130px;
                    width: 44px;
                    height: 44px;
                    border-radius: 50%;
                    background: #2b1f1f;
                    color: #fca5a5;
                    border: 2px solid #ef4444;
                    font: 9px Bungee, sans-serif;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    pointer-events: auto;
                ">DOWN</button>

                <!-- Flight specific: Land (above Descend) -->
                <button id="al-m-land" style="
                    position: absolute;
                    bottom: 60px;
                    right: 126px;
                    width: 42px;
                    height: 42px;
                    border-radius: 50%;
                    background: #1e293b;
                    color: #38bdf8;
                    border: 2px solid #0284c7;
                    font: 9px Bungee, sans-serif;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    pointer-events: auto;
                ">LAND</button>
            </div>
        `;

        document.body.appendChild(root);
        this.root = root;

        // Cache button references
        this.fireBtn = root.querySelector("#al-m-fire");
        this.interactBtn = root.querySelector("#al-m-interact");
        this.jumpBtn = root.querySelector("#al-m-jump");
        this.descendBtn = root.querySelector("#al-m-descend");
        this.landBtn = root.querySelector("#al-m-land");
        this.adsBtn = root.querySelector("#al-m-ads");
        this.reloadBtn = root.querySelector("#al-m-reload");
        this.commandBtn = root.querySelector("#al-m-command");
        this.weaponBtn = root.querySelector("#al-m-weapon");
        this.healBtn = root.querySelector("#al-m-heal");
        this.viewBtn = root.querySelector("#al-m-view");
        this.fullscreenBtn = root.querySelector("#al-m-fullscreen");

        this.bindTouchListeners();
    }

    /**
     * Attaches touch/pointer listeners to buttons with preventDefault/stopPropagation
     * and pointer capture so button presses don't interfere with virtual joysticks or camera dragging.
     */
    private bindTouchListeners(): void {
        const bindHold = (btn: HTMLElement | null, onDown: () => void, onUp: () => void) => {
            if (!btn) return;
            btn.addEventListener("pointerdown", e => {
                e.preventDefault();
                e.stopPropagation();
                try {
                    if ("setPointerCapture" in btn && typeof (btn as any).setPointerCapture === "function" && (e as any).pointerId !== undefined) {
                        (btn as any).setPointerCapture((e as any).pointerId);
                    }
                } catch {}
                btn.style.transform = "scale(0.92)";
                onDown();
            });
            const release = (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                btn.style.transform = "none";
                onUp();
            };
            btn.addEventListener("pointerup", release);
            btn.addEventListener("pointercancel", release);
        };

        const bindTap = (btn: HTMLElement | null, action: () => void) => {
            if (!btn) return;
            btn.addEventListener("pointerdown", e => {
                e.preventDefault();
                e.stopPropagation();
                try {
                    if ("setPointerCapture" in btn && typeof (btn as any).setPointerCapture === "function" && (e as any).pointerId !== undefined) {
                        (btn as any).setPointerCapture((e as any).pointerId);
                    }
                } catch {}
                btn.style.transform = "scale(0.92)";
                action();
            });
            const release = (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                btn.style.transform = "none";
            };
            btn.addEventListener("pointerup", release);
            btn.addEventListener("pointercancel", release);
        };

        // Fire: continuous trigger hold
        bindHold(
            this.fireBtn,
            () => {
                this.cb.setTrigger(true, true);
                this.cb.controllerButton("RightTrigger2", true);
            },
            () => {
                this.cb.setTrigger(false, false);
                this.cb.controllerButton("RightTrigger2", false);
            }
        );

        // Jump / Rise: hold while pressed
        bindHold(
            this.jumpBtn,
            () => {
                this.cb.controllerButton("South", true);
            },
            () => {
                this.cb.controllerButton("South", false);
            }
        );

        // Descend: hold while pressed
        bindHold(
            this.descendBtn,
            () => {
                this.cb.controllerButton("East", true);
            },
            () => {
                this.cb.controllerButton("East", false);
            }
        );

        // Interact: single tap (onKey 'e')
        bindTap(this.interactBtn, () => {
            this.cb.onKey("e");
        });

        // Land: single tap (onKey 'l')
        bindTap(this.landBtn, () => {
            this.cb.onKey("l");
        });

        // ADS: toggle mode
        bindTap(this.adsBtn, () => {
            this.adsActive = !this.adsActive;
            this.cb.setAds(this.adsActive);
            if (this.adsBtn) {
                this.adsBtn.style.background = this.adsActive ? "#c41a1f" : "#161414";
                this.adsBtn.style.borderColor = this.adsActive ? "#ffc83b" : "#888";
            }
        });

        // Reload
        bindTap(this.reloadBtn, () => {
            this.cb.onKey("r");
        });

        // Command Console
        bindTap(this.commandBtn, () => {
            this.cb.onKey("Tab");
        });

        // Weapon cycle
        bindTap(this.weaponBtn, () => {
            this.cb.controllerButton("RightTrigger", true);
            this.cb.controllerButton("RightTrigger", false);
        });

        // Quick heal
        bindTap(this.healBtn, () => {
            this.cb.onKey("h");
        });

        // First/third person camera
        bindTap(this.viewBtn, () => {
            this.cb.onKey("v");
        });

        // Fullscreen toggle
        bindTap(this.fullscreenBtn, () => {
            this.requestFullscreenAndLockLandscape();
        });
    }

    private setupOrientationListener(): void {
        if (typeof window === "undefined") return;
        window.addEventListener("resize", () => this.checkOrientation());
        window.addEventListener("orientationchange", () => this.checkOrientation());
        this.checkOrientation();
    }

    private checkOrientation(): void {
        if (typeof window === "undefined" || !this.orientationPrompt) return;
        if (!this.isTouchDevice) {
            this.orientationPrompt.style.display = "none";
            return;
        }
        const isPortrait = window.innerHeight > window.innerWidth;
        const shouldShow = isPortrait && !this.ignoreOrientation;
        this.orientationPrompt.style.display = shouldShow ? "flex" : "none";
    }

    /**
     * Requests browser fullscreen and attempts to lock orientation to landscape.
     */
    public async requestFullscreenAndLockLandscape(): Promise<void> {
        try {
            if (!document.fullscreenElement) {
                await document.documentElement.requestFullscreen().catch(() => {});
            }
            if (screen.orientation && "lock" in screen.orientation) {
                await (screen.orientation as any).lock("landscape").catch(() => {});
            }
        } catch {
            // Orientation lock may not be supported on all browsers (e.g. desktop or iOS Safari)
        }
        this.checkOrientation();
    }

    /**
     * Updates visibility and contextual labels each frame based on current game mode.
     */
    public update(mode: Mode, controller: Controller, time: number): void {
        this.currentMode = mode;

        // If not a touch device, ensure all mobile elements and joysticks are hidden and do nothing
        if (!this.isTouchDevice) {
            if (VirtualJoystick.Canvas) VirtualJoystick.Canvas.style.display = "none";
            if (this.root) this.root.style.display = "none";
            if (this.orientationPrompt) this.orientationPrompt.style.display = "none";
            return;
        }

        const inGameplay = mode === "play" || mode === "speech";

        // Toggle joysticks and UI visibility
        if (inGameplay) {
            this.initJoysticks();
            if (VirtualJoystick.Canvas) VirtualJoystick.Canvas.style.display = "block";
            if (this.root) this.root.style.display = "block";
        } else {
            if (VirtualJoystick.Canvas) VirtualJoystick.Canvas.style.display = "none";
            if (this.root) this.root.style.display = "none";
        }

        if (!inGameplay) return;

        // Poll Babylon VirtualJoysticks
        if (this.leftStick && this.rightStick) {
            const leftPressed = this.leftStick.pressed;
            const rightPressed = this.rightStick.pressed;

            const leftX = leftPressed ? this.leftStick.deltaPosition.x : 0;
            const leftY = leftPressed ? this.leftStick.deltaPosition.y : 0;

            const rightX = rightPressed ? this.rightStick.deltaPosition.x : 0;
            const rightY = rightPressed ? this.rightStick.deltaPosition.y : 0;

            if (leftPressed || rightPressed) {
                controller.axis([leftX, leftY], [rightX, rightY], time);

                // Auto-sprint when joystick pushed near boundary
                const pushMag = Math.hypot(leftX, leftY);
                if (pushMag > 0.75) {
                    controller.held.add("LeftThumb");
                } else if (!leftPressed) {
                    controller.held.delete("LeftThumb");
                }
            } else {
                controller.held.delete("LeftThumb");
            }
        }

        // Contextual button updates
        const piloting = this.cb.isPiloting();
        const cobra = this.cb.isCobra();

        if (piloting) {
            if (this.jumpBtn) this.jumpBtn.textContent = "RISE";
            if (this.descendBtn) this.descendBtn.style.display = "flex";
            if (this.landBtn) this.landBtn.style.display = "flex";
            if (this.reloadBtn) this.reloadBtn.style.display = "none";
            if (this.adsBtn) this.adsBtn.style.display = "none";
            if (this.fireBtn) this.fireBtn.textContent = cobra ? "MISSILE" : "BOOST";
        } else {
            if (this.jumpBtn) this.jumpBtn.textContent = "JUMP";
            if (this.descendBtn) this.descendBtn.style.display = "none";
            if (this.landBtn) this.landBtn.style.display = "none";
            if (this.reloadBtn) this.reloadBtn.style.display = "flex";
            if (this.adsBtn) this.adsBtn.style.display = "flex";
            if (this.fireBtn) this.fireBtn.textContent = "FIRE";
        }

        // Update Interact button prompt
        const prompt = this.cb.getPrompt();
        if (this.interactBtn) {
            if (prompt) {
                if (prompt.includes("TALK") || prompt.includes("CONFRONT")) this.interactBtn.textContent = "TALK";
                else if (prompt.includes("ENTER") || prompt.includes("BOARD")) this.interactBtn.textContent = "ENTER";
                else if (prompt.includes("SEARCH")) this.interactBtn.textContent = "SEARCH";
                else if (prompt.includes("LEAVE") || prompt.includes("EXIT")) this.interactBtn.textContent = "EXIT";
                else this.interactBtn.textContent = "USE";
                this.interactBtn.style.borderColor = "#ffc83b";
                this.interactBtn.style.background = "#1b2636";
            } else {
                this.interactBtn.textContent = "USE";
                this.interactBtn.style.borderColor = "#666";
                this.interactBtn.style.background = "#161414";
            }
        }

        // Update Weapon info button
        const weapon = this.cb.getWeapon();
        if (this.weaponBtn && weapon) {
            this.weaponBtn.textContent = `${weapon.name.toUpperCase()} (${weapon.mag}/${weapon.reserve}) ⟳`;
        }
    }

    /**
     * Releases joysticks and removes mobile UI.
     */
    public destroy(): void {
        this.leftStick?.releaseCanvas();
        this.rightStick?.releaseCanvas();
        this.leftStick = null;
        this.rightStick = null;
        if (VirtualJoystick.Canvas) {
            VirtualJoystick.Canvas.remove();
            VirtualJoystick.Canvas = null;
        }
        this.root?.remove();
        this.root = null;
        this.orientationPrompt?.remove();
        this.orientationPrompt = null;
        MobileControls.instance = null;
    }
}
