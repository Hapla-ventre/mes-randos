# Mes Randos

Petite web app perso : une carte où tu traces tes randos (clic par clic), tu leur donnes un nom,
et la distance + le dénivelé (D+/D-) sont calculés automatiquement.

## Mise en place (à faire une seule fois, ~10 min)

### 1. Créer le projet Supabase (la base de données, gratuite)

1. Va sur https://supabase.com et crée un compte (gratuit).
2. Crée un nouveau projet (choisis une région proche, ex. `eu-west`).
3. Une fois le projet créé, va dans **SQL Editor** (menu de gauche) > **New query**,
   colle le contenu du fichier [`supabase.sql`](supabase.sql) de ce dossier, et clique **Run**.
   Ça crée la table `hikes` avec la sécurité (chacun ne voit que ses propres randos).
4. Va dans **Project Settings > API**. Note deux valeurs :
   - **Project URL**
   - **anon public key**

### 2. Configurer l'app avec tes clés

1. Duplique le fichier `config.example.js` de ce dossier, renomme la copie en `config.js`.
2. Ouvre `config.js` et remplace `SUPABASE_URL` et `SUPABASE_ANON_KEY` par les valeurs notées à l'étape précédente.

(`config.js` n'est pas versionné — c'est normal, il contient tes clés de projet.)

### 3. Mettre l'app en ligne (gratuit, avec une URL accessible partout)

Option la plus simple, sans compte GitHub :

1. Va sur https://app.netlify.com/drop
2. Glisse-dépose tout le dossier `randonnée` (avec `index.html`, `app.js`, `style.css`, `config.js`) sur la page.
3. Netlify te donne une URL du style `https://un-nom-aleatoire.netlify.app`. C'est ton app, accessible depuis ton PC et ton téléphone.

Tu peux ensuite ajouter cette URL à l'écran d'accueil de ton téléphone pour l'ouvrir comme une appli.

Si tu modifies le code plus tard, il suffira de re-glisser le dossier sur Netlify Drop pour mettre à jour.

### 4. Créer ton compte dans l'app

Ouvre l'URL, clique **Créer un compte** avec ton email et un mot de passe. C'est un compte séparé
de tout le reste (juste pour protéger tes données dans Supabase) — connecte-toi ensuite normalement.

## Utilisation

- **+ Nouvelle rando** → clique sur la carte pour poser les points de ton tracé (comme sur Outdooractive).
- **Terminer le tracé** → l'app calcule distance + dénivelé (via l'altitude de chaque point, API gratuite Open-Meteo).
- Donne un nom, une date, des notes éventuelles, puis **Enregistrer**.
- Toutes tes randos apparaissent sur la carte avec des couleurs différentes, et dans la liste à gauche.
- Clique sur une rando (dans la liste ou sur la carte) pour voir ses stats, son profil d'altitude, et pouvoir la supprimer.

## Notes techniques

- Le dénivelé est approximatif : il dépend de la précision du tracé que tu dessines et de la résolution
  du modèle d'altitude utilisé (~90m). Pour un tracé fidèle, clique des points assez rapprochés dans les zones vallonnées.
- Fond de carte IGN disponible via le sélecteur de calques en haut à droite (plus lisible pour la rando en France).
- Aucune donnée n'est envoyée ailleurs qu'à ton propre projet Supabase et à l'API d'altitude Open-Meteo (anonyme, pas de clé).
