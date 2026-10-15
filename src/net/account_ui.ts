// The account dialog: create an account for the nation you play anonymously, or sign in to one.
// Real form inputs (password managers, paste, mobile keyboards) over the canvas, in the poster
// colors of al_ui.ts. Errors from the server show in the dialog until the player changes something.

export type AccountMode = "create" | "signin";

export interface AccountDialogOptions {
    mode: AccountMode;
    /** A line under the title (what happens to the current nation, for example). */
    note?: string;
    submit(email: string, password: string): Promise<void>;
}

let open: HTMLElement | null = null;

export const accountDialogOpen = (): boolean => !!open;

export function closeAccountDialog(): void {
    open?.remove();
    open = null;
}

/** Shows the dialog; resolves true when the submit succeeded, false when cancelled. */
export function showAccountDialog(o: AccountDialogOptions): Promise<boolean> {
    closeAccountDialog();
    return new Promise(resolve => {
        const root = document.createElement("div");
        root.id = "allegiance-account";
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-modal", "true");
        root.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,8,8,0.72);z-index:10;font-family:Play,sans-serif";
        const create = o.mode === "create";
        root.innerHTML = `
<form style="width:min(440px,calc(100vw - 32px));background:#ebdcb8;border:4px solid #111;outline:2px solid #c41a1f;outline-offset:-12px;padding:28px 30px;box-sizing:border-box;color:#111">
  <h2 style="margin:0 0 6px;font:24px Bungee,sans-serif;color:#c41a1f">${create ? "SAVE YOUR NATION" : "SIGN IN"}</h2>
  <p data-note style="margin:0 0 16px;font-size:15px;line-height:1.35"></p>
  <label style="display:block;font:13px Bungee,sans-serif;margin-bottom:4px" for="al-email">EMAIL</label>
  <input id="al-email" name="email" type="email" autocomplete="email" required style="width:100%;box-sizing:border-box;font:18px Play,sans-serif;padding:8px 10px;border:2px solid #111;background:#fff8e6;margin-bottom:12px">
  <label style="display:block;font:13px Bungee,sans-serif;margin-bottom:4px" for="al-password">PASSWORD${create ? " (8+ CHARACTERS)" : ""}</label>
  <input id="al-password" name="password" type="password" autocomplete="${create ? "new-password" : "current-password"}" required minlength="${create ? 8 : 1}" style="width:100%;box-sizing:border-box;font:18px Play,sans-serif;padding:8px 10px;border:2px solid #111;background:#fff8e6">
  <p data-error role="alert" style="min-height:20px;margin:10px 0;color:#a3070c;font-weight:700;font-size:14px"></p>
  <div style="display:flex;gap:10px;justify-content:flex-end">
    <button type="button" data-cancel style="font:15px Bungee,sans-serif;padding:10px 16px;background:transparent;border:2px solid #111;cursor:pointer">CANCEL</button>
    <button type="submit" data-submit style="font:15px Bungee,sans-serif;padding:10px 18px;background:#c41a1f;color:#f5ead0;border:2px solid #111;cursor:pointer">${create ? "CREATE ACCOUNT" : "SIGN IN"}</button>
  </div>
</form>`;
        const form = root.querySelector("form")!;
        const note = root.querySelector<HTMLElement>("[data-note]")!;
        const error = root.querySelector<HTMLElement>("[data-error]")!;
        const submit = root.querySelector<HTMLButtonElement>("[data-submit]")!;
        const email = root.querySelector<HTMLInputElement>("#al-email")!;
        const password = root.querySelector<HTMLInputElement>("#al-password")!;
        note.textContent = o.note ?? (create ? "You are playing anonymously. Give an email and password to keep this nation and play it on any device." : "Sign in to play your nation on this device.");
        // The game listens for keys on the window: keep typing here.
        root.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") finish(false); });
        root.addEventListener("keyup", e => e.stopPropagation());
        root.addEventListener("input", () => { error.textContent = ""; });
        const finish = (ok: boolean) => { closeAccountDialog(); resolve(ok); };
        root.querySelector("[data-cancel]")!.addEventListener("click", () => finish(false));
        form.addEventListener("submit", async e => {
            e.preventDefault();
            submit.disabled = true;
            submit.textContent = "...";
            error.textContent = "";
            try {
                await o.submit(email.value.trim(), password.value);
                finish(true);
            } catch (err) {
                error.textContent = (err as Error).message;
                submit.disabled = false;
                submit.textContent = create ? "CREATE ACCOUNT" : "SIGN IN";
            }
        });
        document.body.appendChild(root);
        open = root;
        email.focus();
    });
}
