---
description: "电脑操控 settings tab: three capability switches (computer use, browser over CDP, locked-Mac operation) over one durable namespace, plus a macOS TCC permission panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-desktop

English | [中文](README.zh.md)

## Summary

The 电脑操控 tab is the user-facing control for the desktop-facing surfaces Colaw may use. It renders three independent switches — Computer use, Browser use, and Locked-Mac operation — over one durable settings namespace (`ui-desktop-control`), and a macOS permission panel that mirrors the host process's live TCC state (Accessibility, Screen Recording). Switch writes are optimistic and never touch macOS grants; the permission panel probes the host through the `desktopPermissions` remote and deep-links System Settings while a grant is missing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The tab ships with the desktop bundle of the Web client. Every switch defaults to `false`: enabling a capability is an explicit user choice made here, and each switch gates its surface independently. Turning Computer use on takes effect when the desktop provider next mounts (application relaunch); turning it off stops new use without revoking any macOS permission the user has granted — a TCC grant belongs to the user and the system, not to this preference.

### The macOS permission panel

Computer use needs the application itself to hold Accessibility and Screen Recording grants. The panel probes the host's own TCC state through the `desktopPermissions` remote, itemizes each grant, and deep-links macOS System Settings while anything is missing; the deep-link re-probes on return so a grant the user just made shows immediately. Every visit to the tab re-probes, and an unanswered probe renders 检测中… rather than a stale claim.

<a id="understand-the-implementation"></a>
## Understand the implementation

The section state lives in a slot store: the durable scope snapshot mirrors into it (switch writes land optimistically and the accepted wire write reconciles), and the probe answers land in the same store through `setPermissions`. The host half registers the namespace schema; the desktop-facing providers read it to decide whether to publish their surfaces. The probe executes in the host process so the OS attributes the permission request to Colaw itself; the browser half holds only the remote call.

<a id="model-experience"></a>
## Model Experience

- **No model-visible surface** — this tab changes user-facing capability switches only; it contributes no tool, prompt section, or event. A session observes the switches solely through which desktop-facing providers and tools the host mounts.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Browser use and Locked-Mac operation have no consumer yet** — the durable fields persist, but no provider reads them; the switches are the contract ahead of those surfaces shipping.
