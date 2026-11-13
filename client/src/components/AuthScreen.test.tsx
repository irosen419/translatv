// @vitest-environment happy-dom
//
// The sign in and sign up screen, rendered: the invite field takes only a code's own characters
// in the code's own shape, the password can be shown, and each password rule is ticked off as it
// is met, with the button held until all of them are.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyFor } from "../i18n/copy.js";
import type { AuthOutcome } from "../lib/session.js";
import { AuthScreen } from "./AuthScreen.jsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copy = copyFor("en-US");
let host: HTMLDivElement;
let root: Root;
let signUps: { invite?: string; email: string; password: string; displayName: string }[];

const never: AuthOutcome = { ok: false, error: "NETWORK" };

function render(): void {
  act(() => {
    root.render(
      <AuthScreen
        signupMode="invite"
        error={null}
        onSignIn={async () => never}
        onSignUp={async (input) => {
          signUps.push(input);
          return never;
        }}
      />,
    );
  });
}

function byId<T extends HTMLElement>(id: string): T {
  const el = host.querySelector<T>(`#${id}`);
  if (!el) throw new Error(`no #${id}`);
  return el;
}

/** Type into a React controlled input the way a browser does: set the value, fire input. */
function type(id: string, value: string): void {
  const input = byId<HTMLInputElement>(id);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function toSignUp(): void {
  render();
  act(() => button(copy.t("auth.switch.toSignUp")).click());
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  signUps = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the invite field", () => {
  it("shows a lowercase code as uppercase, in dashed groups of four", () => {
    toSignUp();
    type("auth-invite", "2cpwgdfbqtvt");
    expect(byId<HTMLInputElement>("auth-invite").value).toBe("2CPW-GDFB-QTVT");
  });

  it("drops what cannot be in a code and stops at the code's length", () => {
    toSignUp();
    type("auth-invite", "2c pw!gdfb_qtvt99");
    expect(byId<HTMLInputElement>("auth-invite").value).toBe("2CPW-GDFB-QTVT");
  });

  it("holds the button until the code is complete", () => {
    toSignUp();
    type("auth-name", "Ana");
    type("auth-email", "ana@example.test");
    type("auth-password", "Abcdef1!");
    type("auth-invite", "2CPW-GDFB");
    expect(button(copy.t("auth.submit.signUp")).disabled).toBe(true);
    type("auth-invite", "2CPW-GDFB-QTVT");
    expect(button(copy.t("auth.submit.signUp")).disabled).toBe(false);
  });
});

describe("the password field", () => {
  it("can be shown and hidden again", () => {
    render();
    const input = byId<HTMLInputElement>("auth-password");
    expect(input.type).toBe("password");
    act(() => button(copy.t("auth.password.show")).click());
    expect(input.type).toBe("text");
    expect(button(copy.t("auth.password.hide")).getAttribute("aria-pressed")).toBe("true");
    act(() => button(copy.t("auth.password.hide")).click());
    expect(input.type).toBe("password");
  });

  it("lists the rules on sign up, ticking each one as it is met", () => {
    toSignUp();
    const met = () => [...host.querySelectorAll(".password-rules li.met")].map((li) => li.getAttribute("data-rule"));
    expect(met()).toEqual([]);
    type("auth-password", "abc");
    expect(met()).toEqual(["lowercase"]);
    type("auth-password", "Abcdefg1!");
    expect(met()).toEqual(["length", "lowercase", "uppercase", "digit", "symbol"]);
  });

  it("does not list the rules on sign in, where an older password still works", () => {
    render();
    expect(host.querySelector(".password-rules")).toBeNull();
  });

  it("holds the button on sign up until every rule is met, then sends the code as shown", () => {
    toSignUp();
    type("auth-invite", "2cpwgdfbqtvt");
    type("auth-name", "Ana");
    type("auth-email", "ana@example.test");
    type("auth-password", "abcdefgh");
    const submit = button(copy.t("auth.submit.signUp"));
    expect(submit.disabled).toBe(true);
    type("auth-password", "Abcdefg1!");
    expect(submit.disabled).toBe(false);
    act(() => submit.click());
    expect(signUps).toEqual([
      { invite: "2CPW-GDFB-QTVT", email: "ana@example.test", password: "Abcdefg1!", displayName: "Ana" },
    ]);
  });
});
