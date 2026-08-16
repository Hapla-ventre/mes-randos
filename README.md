# Mes Randos

Petite web app perso : une carte où tu traces tes randos (clic par clic), tu leur donnes un nom,
et la distance + le dénivelé (D+/D-) sont calculés automatiquement.

Le site est déjà en ligne : https://hapla-ventre.github.io/mes-randos/
Il ne reste qu'à brancher Firebase (la base de données qui stocke tes randos) pour que ça fonctionne pour de vrai.

## Mise en place (à faire une seule fois, ~10 min)

### 1. Créer le projet Firebase (gratuit)

1. Va sur https://console.firebase.google.com et crée un projet (le nom n'a pas d'importance).
2. Dans le menu de gauche, va dans **Build > Authentication** > **Get started**, onglet **Sign-in method**,
   active le fournisseur **Email/Password**.
3. Va dans **Build > Firestore Database** > **Create database**, choisis le mode **production**, une région proche (ex. `eur3`).
4. Une fois la base créée, onglet **Rules**, remplace le contenu par celui du fichier [`firestore.rules`](firestore.rules)
   de ce dossier, puis **Publish**. Ça garantit que chacun ne voit que ses propres randos.
5. Dans **Project settings** (roue crantée en haut à gauche) > onglet **General**, descends jusqu'à **Your apps**,
   clique l'icône `</>` pour ajouter une "web app" (nom libre, pas besoin de cocher Hosting). Firebase t'affiche
   un objet `firebaseConfig` : garde cette page ouverte pour l'étape suivante.
6. Toujours dans **Authentication > Settings > Authorized domains**, clique **Add domain** et ajoute :
   `hapla-ventre.github.io` (sinon la connexion sera refusée depuis le site en ligne).

### 2. Configurer l'app avec tes clés

1. Ouvre [`config.example.js`](config.example.js), copie son contenu.
2. Sur https://github.com/Hapla-ventre/mes-randos, clique **Add file > Create new file**, nomme-le `config.js`,
   colle le contenu, puis remplace chaque valeur par celles de ton `firebaseConfig` (étape 5 ci-dessus).
3. Commit directement sur `main`. Le site se met à jour tout seul en ~1 minute.

(`config.js` n'est pas dans le dépôt de base exprès — sur ton PC, `config.js` reste ignoré par git,
donc si tu modifies le code en local pense à le recréer toi-même avec tes clés pour tester.)

### 3. Créer ton compte dans l'app

Ouvre https://hapla-ventre.github.io/mes-randos/, clique **Créer un compte** avec ton email et un mot de passe.
C'est un compte séparé de tout le reste (juste pour protéger tes données dans Firebase) — connecte-toi ensuite normalement.

## Mettre à jour le code plus tard

Si tu modifies les fichiers en local, pousse simplement sur GitHub :

```bash
git add -A
git commit -m "description du changement"
git push
```

Le site se met à jour automatiquement en ~1 minute (GitHub Pages).

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
- Aucune donnée n'est envoyée ailleurs qu'à ton propre projet Firebase et à l'API d'altitude Open-Meteo (anonyme, pas de clé).
- Leaflet et le SDK Firebase sont embarqués localement dans `vendor/` (pas de dépendance à un CDN externe).
