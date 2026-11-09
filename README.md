# Valle del Musgo · Servidor del juego

Este servidor hace tres cosas:

- **Cuentas:** registro e inicio de sesión con correo y contraseña. La contraseña se guarda cifrada con scrypt, nunca en texto plano.
- **Salas:** una sala pública y salas privadas con código de 6 caracteres.
- **Multijugador en vivo:** los jugadores de una misma sala se ven, se mueven, chatean y pueden pelear fuera del pueblo.

Además sirve el juego: abrís la dirección del servidor en el navegador y ya estás jugando.

Está hecho con **Node.js puro, sin dependencias**, igual que el verificador de cargas. No hace falta `npm install`, ni Python, ni herramientas de compilación.

---

## Qué hay en la carpeta

| Archivo | Para qué sirve |
|---|---|
| `server.js` | El servidor completo |
| `public/index.html` | El juego |
| `data/` | Se crea sola. Guarda `cuentas.json`, `sesiones.json` y `salas.json` |
| `package.json` | Para que Render sepa cómo arrancarlo |

---

## 1. Probarlo en tu PC (Windows)

1. Copiá la carpeta `servidor-juego` al Escritorio. Por ejemplo: `Escritorio\SERVIDOR JUEGO`.
2. Abrí la carpeta, hacé clic en la barra de dirección del Explorador, escribí `cmd` y apretá Enter. Se abre una terminal ya parada en la carpeta.
3. Escribí:
   ```
   node server.js
   ```
4. Tiene que aparecer:
   ```
   Valle del Musgo · servidor encendido
   Abrí en el navegador: http://localhost:3000
   ```
5. Abrí **http://localhost:3000** en el navegador. Arriba de la pantalla de inicio tiene que decir **"Modo online"**.
6. Creá una cuenta, creá una sala privada y copiá el código.
7. Para probar con dos jugadores en tu misma PC, abrí una ventana de incógnito en http://localhost:3000, creá otra cuenta y entrá con el código.

Para apagar el servidor: en la terminal apretá `Ctrl + C`.

### Jugar con alguien en tu misma red Wi-Fi

1. En otra terminal escribí `ipconfig` y buscá **Dirección IPv4**. Por ejemplo, `192.168.0.15`.
2. La otra persona abre `http://192.168.0.15:3000` en su navegador.
3. Si Windows pregunta por el Firewall la primera vez, tocá **Permitir acceso**.

---

## 2. Publicarlo en internet con Render (recomendado)

Así cualquiera juega desde su casa con una dirección del tipo `https://valle-del-musgo.onrender.com`.

1. **Subí la carpeta a GitHub**
   - Entrá a github.com → **New repository** → nombre: `valle-del-musgo` → **Create**.
   - Tocá **uploading an existing file** y arrastrá **todo lo que hay dentro** de la carpeta (`server.js`, `package.json`, `README.md`, `.gitignore`, la carpeta `public`). La carpeta `data` no hace falta.
   - **Commit changes**.
2. **Creá el servicio en Render**
   - Entrá a render.com con tu cuenta de GitHub → **New +** → **Web Service** → elegí el repositorio `valle-del-musgo`.
   - Completá así:
     - **Runtime:** Node
     - **Build Command:** dejalo vacío, o poné `echo listo`
     - **Start Command:** `node server.js`
     - **Instance Type:** Free
   - **Create Web Service**. En 1 o 2 minutos aparece **Live** y la dirección pública.
3. Abrí esa dirección y jugá. Las salas, el chat y el PvP funcionan igual que en tu PC (Render soporta WebSocket).

### Importante sobre el plan gratis de Render

- **Se duerme** después de 15 minutos sin uso. La primera visita tarda unos 30 a 50 segundos en despertarlo.
- **No guarda archivos para siempre.** Cuando Render reinicia o volvés a publicar, se borran `data/cuentas.json` y las salas, y hay que crear las cuentas de nuevo.
- **Para que no se borren:** en Render agregá un **Disk** (es pago, unos pocos dólares por mes), montalo en `/var/data` y en **Environment** agregá la variable `DATA_DIR` con el valor `/var/data`.

### Probar rápido sin Render (ngrok)

Con el servidor encendido en tu PC, en otra terminal:
```
ngrok http 3000
```
ngrok te da una dirección `https://...ngrok-free.app` que podés pasarle a otra persona mientras tu PC esté prendida.

---

## Cómo funciona el multijugador

- Cada jugador manda su posición 10 veces por segundo, y el servidor reparte las de todos a la sala.
- **PvP:** cuando tu ataque toca a otro jugador, el servidor lo valida y le avisa a esa persona.
  - No pasa si alguno de los dos está en el pueblo, porque ahí no hay PvP.
  - No pasa si están a más de 40 m.
- **Muertes:** aparecen en el chat de la sala.
- **Una cuenta, una conexión:** si entrás con la misma cuenta desde otro lugar, se cierra la conexión anterior.
- **Límites:**
  - 20 jugadores por sala.
  - Chat de 140 caracteres, con un mensaje cada 0,7 segundos como máximo.
  - 15 intentos de inicio de sesión cada 5 minutos por conexión.

### Qué todavía es de cada jugador

Esto queda guardado en el navegador de cada uno y todavía no se comparte:

- Criaturas, recursos y saqueadores.
- La base y los clanes.
- Las bolsas que quedan en el suelo.

Cada jugador ve lo suyo. Lo que sí es compartido:

- Las cuentas.
- Las salas.
- El mapa: mismo código, mismo mundo.
- Los otros jugadores.
- El chat.
- El PvP.

---

## Actualizar el juego

Cuando haya una versión nueva del juego, reemplazá `public/index.html` por la nueva.

- **En tu PC:** reiniciá el servidor.
- **En Render:** subí el archivo nuevo a GitHub y Render vuelve a publicar solo.

## Direcciones del servidor (por si querés conectarlas a otra cosa)

| Método | Dirección | Qué hace |
|---|---|---|
| GET | `/api/estado` | Responde si el servidor está vivo y cuántos jugadores hay |
| POST | `/api/registro` | `{email, password, nombre}`: crea la cuenta |
| POST | `/api/login` | `{email, password}`: devuelve un token de sesión |
| GET | `/api/yo` | Con `Authorization: Bearer <token>`: tus datos |
| POST | `/api/salir` | Cierra la sesión |
| POST | `/api/salas` | Crea una sala privada y devuelve el código |
| GET | `/api/salas/CODIGO` | Datos de una sala (`PUBLICA` para la pública) |
| WebSocket | `/juego?token=...&sala=CODIGO` | Conexión del juego en vivo |
