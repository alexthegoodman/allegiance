// Input: keyboard, mouse and gamepads, with the engine's semantics (Entropy.Input), so the game's
// handlers are unchanged:
// - keys by name ("w", "W", " ", "Tab", "Escape", "ArrowLeft", "Control"...), held state by name;
// - mouse buttons 0 left, 1 right, 2 middle; wheel dy positive away from you (zoom in);
// - controllers as semantic buttons (Gilrs' names: South, East, West, North, LeftTrigger(2),
//   RightTrigger(2), Select, Start, LeftThumb, RightThumb, DPad*) and sticks with positive Y up,
//   from the standard Gamepad mapping (Xbox and DualShock alike).

export interface InputHandlers {
    keyDown(key: string): void;
    mouseDown(button: number, x: number, y: number): void;
    mouseMove(x: number, y: number): void;
    mouseUp(button: number): void;
    mouseWheel(dx: number, dy: number): void;
    gamepadButton(button: string, pressed: boolean): void;
    gamepadAxis(left: [number, number], right: [number, number]): void;
}

/** Standard Gamepad API button order. */
const PAD_BUTTONS = ["South", "East", "West", "North", "LeftTrigger", "RightTrigger", "LeftTrigger2", "RightTrigger2", "Select", "Start", "LeftThumb", "RightThumb", "DPadUp", "DPadDown", "DPadLeft", "DPadRight"];

/** DOM buttons (0 left, 1 middle, 2 right) to the engine's (0 left, 1 right, 2 middle). */
const MOUSE_BUTTON = [0, 2, 1];

export class Input {
    private held = new Set<string>();
    private shift = false;
    private padState = new Map<number, boolean[]>();
    private handlers: InputHandlers | null = null;

    constructor(private target: HTMLElement) {
        window.addEventListener("keydown", e => {
            // The game owns these keys (Tab opens the console, Space jumps, arrows look).
            if (["Tab", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace"].includes(e.key) || e.ctrlKey && e.key.length === 1) e.preventDefault();
            this.shift = e.shiftKey;
            this.held.add(e.key);
            // Presses, not auto-repeat (holding E must not keep using things); Backspace repeats.
            if (!e.repeat || e.key === "Backspace") this.handlers?.keyDown(e.key);
        });
        window.addEventListener("keyup", e => {
            this.shift = e.shiftKey;
            this.held.delete(e.key);
            // A letter released with or without shift: both spellings go.
            if (e.key.length === 1) { this.held.delete(e.key.toLowerCase()); this.held.delete(e.key.toUpperCase()); }
        });
        window.addEventListener("blur", () => { this.held.clear(); this.shift = false; });
        let lastPointerDown = 0;
        target.addEventListener("contextmenu", e => e.preventDefault());
        target.addEventListener("pointerdown", e => {
            lastPointerDown = performance.now();
            target.focus();
            if (e.pointerType === "touch") e.preventDefault();
            this.handlers?.mouseDown(MOUSE_BUTTON[e.button] ?? e.button, e.clientX, e.clientY);
        });
        target.addEventListener("mousedown", e => {
            if (performance.now() - lastPointerDown < 250) return;
            target.focus();
            e.preventDefault();
            this.handlers?.mouseDown(MOUSE_BUTTON[e.button] ?? e.button, e.clientX, e.clientY);
        });
        window.addEventListener("pointermove", e => {
            this.handlers?.mouseMove(e.clientX, e.clientY);
        });
        window.addEventListener("pointerup", e => {
            this.handlers?.mouseUp(MOUSE_BUTTON[e.button] ?? e.button);
        });
        target.addEventListener("wheel", e => { e.preventDefault(); this.handlers?.mouseWheel(-e.deltaX, -e.deltaY); }, { passive: false });
    }

    attach(h: InputHandlers): void { this.handlers = h; }

    isKeyPressed(key: string): boolean { return this.held.has(key); }
    isShiftPressed(): boolean { return this.shift || this.held.has("Shift"); }

    /** Reads the controllers (call once a frame): changed buttons, then both sticks. */
    pollGamepads(): void {
        const h = this.handlers;
        if (!h || typeof navigator.getGamepads !== "function") return;
        for (const pad of navigator.getGamepads()) {
            if (!pad || !pad.connected) continue;
            const prev = this.padState.get(pad.index) ?? [];
            const now = pad.buttons.map(b => b.pressed || b.value > 0.5);
            now.forEach((p, i) => { if (p !== !!prev[i] && PAD_BUTTONS[i]) h.gamepadButton(PAD_BUTTONS[i], p); });
            this.padState.set(pad.index, now);
            const a = pad.axes;
            h.gamepadAxis([a[0] ?? 0, -(a[1] ?? 0)], [a[2] ?? 0, -(a[3] ?? 0)]);
            break;
        }
    }
}
