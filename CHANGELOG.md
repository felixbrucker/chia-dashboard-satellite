1.5.0 / 2021-05-12
==================

* Add support for reporting harvester response times for the farmer stats.
* Fix satellite initialization throwing unhandled errors when the chia node is slow to respond.
* Fix errors being thrown with full stack traces for some failed http requests.

1.4.0 / 2021-05-11
==================

* Add the satellite version to dashboard api requests.
* Add an info log on startup showing the loaded config location.
* Show a better error message when the api key is invalid.
* Reset the plotter stats on startup as well.

1.3.0 / 2021-05-06
==================

* Add support for basic gui plotter stats.
* Add support for excluding services via `excludedServices` config option.

1.2.0 / 2021-04-28
==================

* Do not require git anymore.
* Fix a bug where throwing an error failed.

1.1.1 / 2021-04-27
==================

* Add missing shebang line.

1.1.0 / 2021-04-25
==================

* Aggregate farming infos.

1.0.1 / 2021-04-24
==================

* Initial release.
