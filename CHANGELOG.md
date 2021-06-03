1.10.0 / 2021-06-03
==================

* Add `https://us.chiadashboard.com` dashboard core url to first run wizard.
* Decrease stats update payload size for farmer, harvester and full nodes.

1.9.2 / 2021-05-23
==================

* Fix wallets without any keys present preventing satellite initialization.

1.9.1 / 2021-05-23
==================

* Fix wallet stats unavailable when the wallet was never logged into before.

1.9.0 / 2021-05-19
==================

* Add support for selecting the `chiaDashboardCoreUrl` config option in the first run wizard.
* Show the used `chiaDashboardCoreUrl` on startup.

1.8.0 / 2021-05-19
==================

* Add support for using any chia-dashboard-core via `chiaDashboardCoreUrl` config option.

1.7.0 / 2021-05-15
==================

* Add support for only counting unique balances in the wallet summary.
* Fix a problem that could result in increased RTs when a chain re-org happens within the last 20 SPs.

1.6.2 / 2021-05-14
==================

* Fix the daemon api connection not getting properly closed on exit.

1.6.1 / 2021-05-14
==================

* Fix custom config location validation in first run wizard.

1.6.0 / 2021-05-14
==================

* Use unified service names for stats reporting.
* Increase stats updating interval.

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
