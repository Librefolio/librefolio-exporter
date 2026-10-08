# ⚠️ Risks

Read this before using the extension.

## Scalable's terms

Scalable's client terms allow it to block access to the client area for security
reasons. From the Italian client documentation in force since 1 September 2026,
*Termini e Condizioni Generali*, §4.5 (the English version is in the same document):

> «Suspicion of unauthorised or abusive access arise, in particular, if attempts to log
> on to the Platform fail repeatedly, if the login credentials check repeatedly yields a
> negative result and/or if there are plausible indications of the use of computer
> programs to access the Platform.»

The terms do not say what counts as such an indication. If Scalable blocks your access,
contact its support. Use the extension at your own risk.

## Built for light use

The extension keeps the risk low:

- it only runs when you click, inside your own logged-in browser;
- it never touches your credentials, cookies or two-factor codes;
- requests go one at a time, with a random pause of 0.3–0.7 seconds between them, and
  it backs off when Scalable answers "too many requests";
- details cost one request each, per executed trade (fees and taxes) and per interest
  payment of the overnight account (gross amount and tax), and can be turned off;
- the overnight account is read with the web app's own queries, so it never sends
  queries that Scalable would refuse;
- after the first export, only new transactions are read.

The risk grows with **intensive use**, for example exporting your whole history many
times a day.

## The web app can change

The extension reads the web app's internal interface, which is not public and can
change at any time. When it changes, the export can stop working until a new version
of the extension adapts to it: the panel then shows an error with a *technical details*
line, to include in a [bug report](https://github.com/Librefolio/librefolio-exporter/issues).

## An official alternative

Scalable also offers an official interface, *Agentic Investing* (CLI and MCP),
activated from Profile › Security on the web.
