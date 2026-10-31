# Fianza

**Una fianza reembolsable de PayPal que los agentes de código dejan para que revisen su pull request.**
El trabajo honesto se libera en $0. Un PR que falla revisiones duras y deterministas puede cobrarse para pagar el tiempo del maintainer, pero solo si un maintainer lo confirma.
La decisión se basa en evidencia citada del diff y del CI, nunca en cómo está escrita la descripción.

[Read in English](README.md) · [Para jueces](JUDGES.md) · Solo sandbox: no se mueve dinero real.

## El problema

Los maintainers reciben más pull requests de agentes de los que pueden revisar, y revisar uno malo cuesta la misma hora que uno bueno. Prohibir a los agentes tira también los buenos. Fianza les da a los PRs declarados como de agente un carril exprés con un depósito pequeño y reembolsable:

- el humano del agente aprueba una **retención** en PayPal (una autorización, no un cobro);
- un maintainer decide en **48 horas**, o la retención se anula sola;
- el resultado por defecto es **anular**: el trabajo honesto cuesta $0;
- para cobrar se necesitan **2 o más señales duras y deterministas** (CI fallando, pruebas borradas o saltadas, aserciones que siempre pasan) **y** el comando de un maintainer, con un tope mensual;
- si ganas una apelación, se reembolsa completa.

A los humanos nunca se les pide fianza. Los PRs que no se declaran como de agente van por el carril gratuito normal.

## Cómo funciona

1. El agente abre un PR. Fianza responde **HTTP 402** con el monto, los términos y un enlace de aprobación para su humano. El agente se detiene.
2. El humano aprueba la retención con el botón de PayPal (JS SDK v6). El servidor confirma con PayPal antes de darla por hecha.
3. Corre el CI. Reglas deterministas sobre el diff y una revisión de afirmaciones con Claude Opus 5.5 arman un reporte con citas, en inglés y español.
4. El maintainer comenta `/fianza aceptar`, `/fianza cobrar` o `/fianza apelar`. Fianza anula, cobra o reembolsa en PayPal, una sola vez.
5. Cada 15 minutos un cron anula las retenciones sin decisión después de 48 horas.

El diagrama, la tabla de endpoints de PayPal y las garantías de corrección de pagos, con sus pruebas, están en el [README en inglés](README.md).

## Qué decide y qué nunca decide

- **Sí puede proponer un cobro:** CI fallando, archivos de prueba borrados, aserciones eliminadas, `.skip`/`.only`, `expect(true)`. Se necesitan al menos 2, y cada una cita archivo y línea.
- **Nunca puede proponer un cobro:** la revisión de Claude. Sus hallazgos son informativos y el modelo nunca mueve dinero.
- **Congela en REVISIÓN:** instrucciones escondidas en el PR (en inglés o español, comentarios HTML, caracteres invisibles), CI pendiente o una revisión de afirmaciones incompleta.
- **No importa:** el idioma o el estilo de la descripción. Una prueba de propiedades lo verifica.

## Correrlo localmente

```bash
pnpm install
cp .env.example .env.local   # credenciales de una app SANDBOX de PayPal
pnpm test                    # no necesita credenciales
pnpm dev                     # http://localhost:3000
```

## Límites honestos

- **Solo sandbox.** La app rechaza cualquier `PAYPAL_ENV` que no sea `sandbox`.
- **Basado en declaración.** Fianza pone precio al trabajo de agente declarado; no intenta detectar agentes que no se declaran.
- **El tope mensual cuenta todos los cobros del repo**, así que solo puede activarse antes, nunca después.
- **Gana la última escritura** en el registro; antes de mover dinero siempre se lee el estado de PayPal como respaldo.
- **Tras una anulación automática no se actualiza la etiqueta del PR** en GitHub; el panel y PayPal sí quedan correctos.

## Licencia

[MIT](LICENSE)
