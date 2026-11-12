export function Login(props: { error?: string }) {
  return (
    <html lang="it">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Accedi - CSP Monitor</title>
        <link rel="stylesheet" href="/static/style.css" />
      </head>
      <body>
        <main>
          <h1>Accedi</h1>
          {props.error ? <p role="alert">{props.error}</p> : null}
          <form method="post" action="/login">
            <label>
              Password
              <input type="password" name="password" autocomplete="current-password" required autofocus />
            </label>
            <button type="submit">Accedi</button>
          </form>
        </main>
      </body>
    </html>
  );
}
