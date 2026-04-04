# error

XMPP error abstraction for JavaScript.

This module is part of this repository's internal package set.

## Usage

```js
import XMPPError from "@xmpp/error";

const error = new XMPPError("service-unavailable", "optional text", element);
error instanceof Error; // true
error.condition === "service-unavailable"; // true
error.text === "service-unavailabe - optional text"; // true
error.element === element; // true
```
