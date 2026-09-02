export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="login">
      <h1>RR Backoffice</h1>
      {error ? <p className="aviso-error">Contraseña incorrecta.</p> : null}
      <form method="post" action="/api/login">
        <input type="password" name="password" placeholder="Contraseña" autoFocus />
        <button className="boton" type="submit">Entrar</button>
      </form>
    </div>
  );
}
