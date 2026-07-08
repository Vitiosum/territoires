# Territoires — MVP

Connecte ton Strava, récupère tout ton historique, et regarde la carte se colorer : chaque sortie capture des cases (tuiles slippy map zoom 14, comme Veloviewer / Squadrats).

## Fonctionnement

- **Un bouton** : OAuth Strava → la sync complète démarre automatiquement.
- **Sync progressive** : la file d'attente respecte les rate limits Strava (100 req / 15 min). La carte se remplit au fur et à mesure, barre de progression incluse.
- **Webhook** : chaque nouvelle activité arrive toute seule après la sync initiale.

## Déploiement sur Clever Cloud

### 1. Créer l'app Strava

Sur https://www.strava.com/settings/api :
- Crée une application, note le **Client ID** et le **Client Secret**.
- "Authorization Callback Domain" : le domaine de ton app Clever Cloud (ex. `app-xxx.cleverapps.io`), sans `https://`.

### 2. Créer l'app et l'addon

```bash
clever create --type node territoires
clever addon create postgresql-addon territoires-db
clever service link-addon territoires-db
```

### 3. Variables d'environnement

```bash
clever env set STRAVA_CLIENT_ID "ton_client_id"
clever env set STRAVA_CLIENT_SECRET "ton_client_secret"
clever env set STRAVA_SUBSCRIPTION_ID "<id renvoyé par GET /push_subscriptions>"
clever env set STRAVA_VERIFY_TOKEN "une_chaine_aleatoire"
clever env set APP_SECRET "une_autre_chaine_aleatoire"
clever env set BASE_URL "https://app-xxx.cleverapps.io"
```

`POSTGRESQL_ADDON_URI` est injectée automatiquement par l'addon. Le schéma se crée tout seul au premier démarrage.

### 4. Déployer

```bash
git init && git add . && git commit -m "MVP territoires"
clever deploy
```

### 5. Activer le webhook Strava (une seule fois)

```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=TON_CLIENT_ID \
  -F client_secret=TON_CLIENT_SECRET \
  -F callback_url=https://app-xxx.cleverapps.io/webhook/strava \
  -F verify_token=TA_CHAINE_STRAVA_VERIFY_TOKEN
```

## Test en local

```bash
npm install
export POSTGRESQL_ADDON_URI="postgres://user:pass@localhost:5432/territoires"
export STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... APP_SECRET=dev BASE_URL=http://localhost:8080
npm start
```

Pour le callback OAuth en local, mets `localhost` comme callback domain dans les settings Strava.

## Limites connues du MVP (et pistes v2)

- **File d'attente en mémoire** : si l'app redémarre pendant une sync, elle reprend au démarrage (`resumeInterrupted`), mais pour scaler → sortir le worker dans une app Clever Cloud séparée + Redis/Pulsar.
- **Rate limits** : 100 req / 15 min par défaut. Un historique de 2000 activités prend plusieurs heures. Demander une augmentation de quota à Strava quand l'app grossit.
- **Tuiles calculées en Node** : suffisant pour le MVP. Pour les modes de jeu avancés (plus grand carré, clusters, territoires contestés) → passer les calculs en SQL avec PostGIS.
- **App mobile** : le front actuel est une web app responsive. Pour iOS/Android → l'embarquer dans Capacitor, ou refaire le front en Flutter/React Native en gardant exactement la même API.

## Idées de modes de jeu (roadmap)

- Plus grand carré (max square) et plus grand cluster connecté
- % de conquête par commune / département / pays
- Ligues entre amis, cases contestées (le dernier passé la détient)
- Badges : premières 100 cases, 4 pays, etc.
