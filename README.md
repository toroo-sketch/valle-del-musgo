# Valle del Musgo

Juego web multijugador estilo LoL. Cuentas, cofres y partidas en vivo con **Firebase**. Página publicada en **Vercel**.

## Archivos
| Archivo | Para qué sirve |
|---|---|
| `index.html` | El juego completo. Arriba tiene la configuración de Firebase |
| `database.rules.json` | Reglas de seguridad para pegar en Firebase → Realtime Database → Reglas |

## Qué se guarda en Firebase
- **Authentication:** las cuentas (Google o correo y contraseña).
- **Realtime Database:**
  - `jugadores/` → nombre de cada jugador y sus salas.
  - `cofres/` → lo que cada uno guarda en el cofre del pueblo. Queda hasta que lo saque.
  - `salas/` → salas, quién está conectado y dónde, chat y golpes de PvP.

## Puesta en marcha
1. **Firebase:** crear el proyecto, activar Google y Correo/contraseña en Authentication, crear la Realtime Database y pegar `database.rules.json` en sus Reglas.
2. **Configuración:** pegar el `firebaseConfig` de la app web en `window.VALLE_FIREBASE`, arriba de `index.html`.
3. **Vercel:** importar este repositorio y tocar Deploy. No necesita configuración.
4. **Dominio:** en Firebase → Authentication → Configuración → Dominios autorizados, agregar el dominio de Vercel (por ejemplo, `valle-del-musgo.vercel.app`).

## Límites del plan gratis de Firebase
- 100 jugadores conectados a la vez.
- 10 GB por mes de transferencia: unas 90 horas de juego con 5 jugadores juntos.
