# @joaomj/pi-claude-usage

## 0.2.0

### Minor Changes

- [#4](https://github.com/joaomj/pi-extensions/pull/4) [`99b5402`](https://github.com/joaomj/pi-extensions/commit/99b540241de7de3b2a3cf97b02bebc57ec59164a) Thanks [@joaomj](https://github.com/joaomj)! - Keep the usage footer current during a session: refresh at run start, every turn boundary, and run end (at most one request per minute), re-render the reset countdown every 15 seconds, and request again once a window's reset time passes instead of waiting for the five-minute cache to expire. The footer also shows the 5-hour window's reset countdown next to its percentage.

### Patch Changes

- [#4](https://github.com/joaomj/pi-extensions/pull/4) [`5aea017`](https://github.com/joaomj/pi-extensions/commit/5aea017547eeeee2b374b337d28f55709b62694d) Thanks [@joaomj](https://github.com/joaomj)! - Load the usage implementation only for Claude sessions, show the footer only while the session uses Claude, defer the first refresh past startup, and skip startup work when the cached value is fresh.

## 0.1.1

### Patch Changes

- [`466d561`](https://github.com/joaomj/pi-extensions/commit/466d561ccbfafee59256cb8cdef8a65638785e66) Thanks [@joaomj](https://github.com/joaomj)! - Publish through staged npm publishing when a GitHub Release is published.

## 0.1.0

### Minor Changes

- [`c1cedc3`](https://github.com/joaomj/pi-extensions/commit/c1cedc31c087bd615dd917d36c566c6f85bea966) Thanks [@joaomj](https://github.com/joaomj)! - Initial npm release of the small extensions
