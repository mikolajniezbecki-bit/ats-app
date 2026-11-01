# What the owner does for tasks 44–46

This guide lists everything **you** (the project owner) need to do so that Claude can finish the last three tasks:

- **Task 44** describes the whole cloud setup as code.
- **Task 45** puts the app on the internet and checks it there.
- **Task 46** adds the final tests.

Each step says **what** to do, **why** it is needed, and **how** to do it, click by click. No programming knowledge is assumed.

- **Time needed:** about 2–3 hours in total, spread over several sessions.
- **Money:** nothing beyond a card for verification, if the free settings are kept (see [Costs](#costs-and-what-protects-you)).
- **When:** Part 1 can be done right away, before task 44 starts.

> Menu names on Microsoft, GitHub and Cloudflare websites change from time to time. If a button has a slightly different name, look for the closest match. If something doesn't match at all, stop and ask Claude rather than guessing.

---

## Contents

1. [The big picture](#1-the-big-picture)
2. [Words you will meet](#2-words-you-will-meet)
3. [Your notebook: values to collect](#3-your-notebook-values-to-collect)
4. [Part 1, before task 44: accounts and registrations](#part-1-before-task-44-accounts-and-registrations)
5. [Part 2, during task 44: building the cloud environment](#part-2-during-task-44-building-the-cloud-environment)
6. [Part 3, during task 45: going live and checking it by hand](#part-3-during-task-45-going-live-and-checking-it-by-hand)
7. [Part 4, during task 46: final tests](#part-4-during-task-46-final-tests)
8. [Ongoing: reminders and stopping the database between demos](#ongoing-reminders-and-stopping-the-database-between-demos)
9. [Costs and what protects you](#costs-and-what-protects-you)
10. [Summary checklist](#summary-checklist)

---

## 1. The big picture

So far the recruiting app (the "ATS", applicant tracking system) has run only in this development environment (the codespace) and in GitHub's automatic tests. Tasks 44–46 put it on the internet, in **Microsoft Azure**, so that you can demo it from any browser.

To run there, the app needs a few rented building blocks. Each one replaces something it uses today in the codespace:

| In the codespace today | In Azure | What it does for the app |
|---|---|---|
| The app container | **Container Apps** (web app) | Runs the app's code and answers browsers. It "sleeps" when nobody uses it, so it costs almost nothing. |
| PostgreSQL container | **Azure Database for PostgreSQL** | Stores requisitions, applications, offers and users. |
| Azurite (fake file storage) | **Azure Blob Storage** | Stores the CVs and offer-letter PDFs. |
| Mailpit (fake mailbox) | The app's own **Outbox** page | Emails are built but never sent (project rule C4); Admins read them in the Outbox. |
| Test passwords for demo users | **Microsoft Entra ID** sign-in | Staff sign in with Microsoft accounts from your own directory. |
| Fake test keys | **Cloudflare Turnstile** (real keys) | The "I'm not a robot" check on the public application form. |
| `.env` file / fake values | **Key Vault** | A safe for passwords and keys. The app reads them from there; they never appear in GitHub. |
| (nothing) | **Log Analytics** | Keeps the app's logs for 30 days, with a small daily cap so it can't cost money. |
| (nothing) | **Budget alert** | Emails you when the monthly cost passes 80 % and 100 % of EUR 10. |

**How new versions reach Azure (task 45):**

1. Claude's change is merged into `main` on GitHub.
2. GitHub builds the app's "image" (a sealed package of the app), tests it, and stores it in **GHCR** (GitHub's private package store). Task 43 already does all of this.
3. From task 45 on, GitHub also signs in to Azure **without any password stored in GitHub**, updates the database structure and switches the web app to the new image.

**What only you can do:** Claude works inside the codespace and on GitHub, and on purpose has **no access to your Azure account, your Microsoft directory, your Cloudflare account or your GitHub personal settings**.

- **Creating accounts and pressing "deploy" stay in your hands.** Claude writes the code that describes the cloud environment; you create the accounts and decide when to deploy.
- **Some checks need a real person.** For example, signing in with a real Microsoft account in a browser, or seeing the robot check appear.
- **Claude can't start workflows.** Its GitHub access can't press "Run workflow" (found during task 43). You click that button when asked.

---

## 2. Words you will meet

| Word | Plain meaning |
|---|---|
| **Azure** | Microsoft's cloud: computers and services you rent by the minute. |
| **Azure account / subscription** | Your customer account and its "bill". Everything you create is billed to the subscription. |
| **Tenant / directory (Microsoft Entra ID)** | Your own private list of user accounts and apps at Microsoft, like a company's staff directory. A new Azure account gets one automatically, named something like `yourname.onmicrosoft.com`. |
| **Resource group** | A folder in Azure that holds all the project's services. Deleting the folder deletes everything in it. |
| **Region** | Which Microsoft data centre runs your services (for example West Europe in the Netherlands). |
| **App registration** | An entry in your directory that tells Microsoft "this app may ask users to sign in" or "this program may act in my Azure". We create **two**: one for **staff sign-in**, one for **GitHub deployments**. |
| **Service principal** | The "robot user" that an app registration gets in your directory. GitHub acts in Azure as this robot, with only the permissions you give it. |
| **Federated credential (OIDC)** | A trust rule: "Azure accepts GitHub's word that this run comes from the `main` branch of `ats-app`." It replaces a password, so **no Azure secret is ever stored in GitHub**. |
| **Role / role assignment** | A permission ("may manage this folder", "may read secrets") given to a person or robot. |
| **Key Vault** | A secure safe for secrets. Only those you allow can read it. |
| **Secret** | Any password, key or token. Never paste one into GitHub, chat or email. |
| **Bicep** | The language Claude uses to describe the Azure setup as text files, so it can be rebuilt identically. |
| **what-if / deploy** | `what-if` is a dry run: "show me what you *would* change". `deploy` really makes the changes. You always look at a what-if first. |
| **GitHub Actions / workflow** | GitHub's automation. `main.yml` tests and publishes the app; `infra.yml` (new in task 44) builds the Azure environment. |
| **GitHub Actions variable** | A named, **non-secret** setting the workflows read (an ID, a name, an email address). |
| **GHCR** | GitHub's private store for app images. Azure needs a read-only key (a PAT) to download from it. |
| **PAT (personal access token)** | A password-like key you create in GitHub with limited powers and an expiry date. |
| **Cloud Shell** | A command line inside the Azure website. You paste a command, press Enter, and read the answer. Nothing to install. |
| **UPN** | A user's sign-in name in your directory, like `recruiter@yourname.onmicrosoft.com`. |

---

## 3. Your notebook: values to collect

While you work through Part 1 you will collect a few values. Keep **a private note** (for example in a password manager) with two sections.

**A. Non-secret values.** These go into GitHub variables, and it's fine to tell Claude:

| Name | Example | Where it comes from |
|---|---|---|
| Tenant domain | `yourname.onmicrosoft.com` | Step 1.2 |
| Tenant ID (Directory ID) | `1a2b3c4d-…` (a long code with dashes) | Step 1.2 |
| Subscription ID | `5e6f…` | Step 1.1 |
| Region | `westeurope` | Step 1.3 |
| Resource group name | `rg-ats-demo` | Step 1.3 |
| Sign-in app: Application (client) ID | `9a8b…` | Step 1.5 |
| Deploy app: Application (client) ID | `7c6d…` | Step 1.6 |
| Turnstile site key | `0x4AAAA…` | Step 1.8 |
| GitHub user name | `mikolajniezbecki-bit` | You know it |
| Budget alert email | your email | You choose |
| Your own admin UPN | `owner@yourname.onmicrosoft.com` | Step 1.4 |

**B. Secrets.** These go only into Key Vault in Part 2. Never into GitHub, chat or email:

- the sign-in app's **client secret** (step 1.5)
- the **Turnstile secret key** (step 1.8)
- the **GHCR PAT** (step 1.9)
- the **passwords** of the Microsoft demo users (step 1.4)

> If a secret leaks, don't panic. Each of them can be replaced: create a new one, put it in Key Vault, and delete the old one.

---

## Part 1, before task 44: accounts and registrations

You can do all of Part 1 now. When it's done, tell Claude **"Part 1 is done"** and share the section-A values (non-secret).

### Step 1.1 – Create an Azure account and find your subscription ID

- **Why:** everything in the cloud lives in an Azure subscription. The project rules (C1, C2) say it is your personal account, on the free offer.
- **How:**
  1. Go to **azure.microsoft.com/free** and choose **Try Azure for free** (or **Start free**).
  2. Sign in with a Microsoft account (an existing Outlook/Hotmail/Live account, or create one with your email).
  3. Fill in the form. Microsoft asks for a **phone number** and a **credit or debit card** to verify you are a real person. The free offer doesn't charge the card unless you later upgrade to pay-as-you-go *and* use paid services.
  4. When it's finished, open **portal.azure.com**.
  5. In the search bar at the top, type **Subscriptions** and open it. You'll see one subscription (often called "Azure subscription 1"). Click it and copy the **Subscription ID** into your notebook (section A).
- **If you already have an Azure account:** you can use it. Just make sure the subscription you'll use is shown under **Subscriptions** and copy its ID.

### Step 1.2 – Find your tenant (directory) name and ID

- **Why:** staff sign in with accounts from this directory (tech-stack.md §4). The app must be told exactly which directory to trust (rule AU1).
- **How:**
  1. In the portal search bar type **Microsoft Entra ID** and open it.
  2. On the **Overview** page, copy:
     - **Tenant ID** (a code like `1a2b3c4d-1111-2222-3333-444455556666`) into the notebook;
     - **Primary domain** (like `yourname.onmicrosoft.com`) into the notebook as *Tenant domain*.

### Step 1.3 – Choose a region and create the resource group

- **Why:** the resource group is the "folder" that holds every project service, and the deploy robot gets rights to **this folder only** (rule G3). The region must be in the EU and offer the cheap database size the project plans for (PostgreSQL 17, size B1MS).
- **How:**
  1. Search **Resource groups** → **+ Create**.
  2. **Subscription:** your subscription. **Resource group:** `rg-ats-demo` (or another short name without spaces).
  3. **Region:** pick an EU region, for example **(Europe) West Europe** or **(Europe) North Europe**.
  4. **Review + create** → **Create**.
  5. Note the name and the region (written in lower case without spaces, e.g. `westeurope`) in your notebook.
- **Note:** if, during task 44, the cheap database turns out not to be available in your region, Claude will stop and ask you. Don't change it yourself. This happened in Poland Central (`SkuNotAvailable`). The fix keeps the resource group where it is and puts only the database in another EU region: see [step 2.4](#step-24--full-dry-run-then-deploy), "Before you start".

### Step 1.4 – Create the user accounts for the demo

- **Why:** the app is invite-only (rule AU2). Only Microsoft accounts that also exist as users inside the app can sign in. The demo has four roles (Admin, Recruiter, Hiring Manager, Interviewer). The task 45 checks also need two extra accounts, plus one for you as the first Admin.
- **Which accounts** (replace `yourname.onmicrosoft.com` with your tenant domain):

  | UPN | Purpose |
  |---|---|
  | `owner@…` | **You**, as the app's first Admin (used in Part 3). A dedicated directory account is simpler than your personal Microsoft account, which appears in the directory under a long "#EXT#" name. |
  | `admin@…` | Demo Admin |
  | `recruiter@…` | Demo Recruiter |
  | `hm@…` | Demo Hiring Manager |
  | `interviewer@…` | Demo Interviewer |
  | `outsider@…` | Has **no** account in the app: proves that strangers are refused (task 45). |
  | `throwaway@…` | Gets an account in the app and is then deactivated: proves that deactivated users are refused (task 45). |

- **How (repeat for each account):**
  1. **Microsoft Entra ID** → **Users** → **+ New user** → **Create new user**.
  2. **User principal name:** for example `recruiter`, with the domain shown next to it. **Display name:** for example `Demo Recruiter`.
  3. Keep **Auto-generate password** and copy the password into section B of your notebook.
  4. **Review + create** → **Create**.
- **Good to know:**
  - On the first sign-in, Microsoft asks each user to choose a new password. It may also ask to set up the Microsoft Authenticator app (security defaults). That's normal; follow the screens. The first sign-ins happen in Part 3.
  - Don't give these users any Azure roles. They only need to exist.

### Step 1.5 – Register the app for staff sign-in

- **Why:** before Microsoft lets users sign in to an app, the app must be registered in your directory (tech-stack.md §4, rules AU1–AU4). Microsoft then gives the app an ID and a secret, which act like its own user name and password.
- **How:**
  1. **Microsoft Entra ID** → **App registrations** → **+ New registration**.
  2. **Name:** `ATS sign-in`.
  3. **Supported account types:** **Accounts in this organizational directory only (single tenant)**. This matters: the app refuses multi-tenant setups.
  4. **Redirect URI:** platform **Web**, value `http://localhost:3000/api/auth/callback/microsoft`. This is where Microsoft sends the user back after sign-in. The Azure address is added in Part 2, once it exists.
  5. **Register**.
  6. On the app's **Overview** page, copy the **Application (client) ID** into the notebook as *Sign-in app client ID*.
  7. **Certificates & secrets** → **Client secrets** → **+ New client secret**.
     - **Description:** `ATS sign-in`. **Expires:** 12 months, or the longest offered.
     - **Add**, then **immediately copy the "Value"** (not the "Secret ID") into section B. It is shown only once.
     - Note the expiry date; you'll add a reminder (see [Ongoing](#ongoing-reminders-and-stopping-the-database-between-demos)).
  8. **Token configuration** → **+ Add optional claim** → token type **ID** → tick **email** → **Add**. If asked to also add the Microsoft Graph email permission, tick it and confirm. Without this, users without a mailbox (like your demo users) would have no email in their sign-in data; the app then uses their UPN instead.

### Step 1.6 – Register the "robot" that GitHub uses to deploy

- **Why:** task 44's `infra.yml` workflow must create and update services in your resource group. It signs in as a robot (a service principal) whose only rights are on that one folder (rule G3). The "federated credential" means Azure trusts GitHub runs from your repository's `main` branch directly, so no Azure password is ever stored in GitHub. Runs from any other branch are refused.
- **How:**
  1. **Microsoft Entra ID** → **App registrations** → **+ New registration**.
     - **Name:** `ATS GitHub deploy`.
     - **Supported account types:** single tenant.
     - **Redirect URI:** leave empty.
     - **Register**.
  2. Copy its **Application (client) ID** into the notebook as *Deploy app client ID*.
  3. **Certificates & secrets** → tab **Federated credentials** → **+ Add credential**.
     - **Federated credential scenario:** **GitHub Actions deploying Azure resources**.
     - **Organization:** `mikolajniezbecki-bit`. **Repository:** `ats-app`.
     - **Entity type:** **Branch**. **GitHub branch name:** `main`.
     - **Name:** `github-main`.
     - **Add**.
  4. Don't create a client secret for this app. It doesn't need one.

### Step 1.7 – Give the robot its two permissions on the resource group

- **Why:** the robot needs two permissions on the resource group:
  - **Contributor:** may create and change services inside the folder.
  - **Role Based Access Control Administrator, restricted:** may hand out exactly two permissions to the app's own identity. One lets the app read secrets from Key Vault, the other lets it read and write files in storage. The restriction (a "condition") stops the robot from giving anyone any other permission (task 44, decision Q2).
- **How:**
  1. Open your resource group (search **Resource groups** → `rg-ats-demo`).
  2. **Access control (IAM)** → **+ Add** → **Add role assignment**.
  3. **First assignment:**
     1. Tab **Privileged administrator roles** → choose **Contributor** → **Next**.
     2. **Assign access to:** **User, group, or service principal** → **+ Select members**. Search `ATS GitHub deploy` → select → **Select**.
     3. **Review + assign**. Confirm the warning about a privileged role.
  4. **Second assignment:** **+ Add** → **Add role assignment** again.
     1. Tab **Privileged administrator roles** → choose **Role Based Access Control Administrator** → **Next**.
     2. **Members:** select `ATS GitHub deploy` again → **Next**.
     3. On the **Conditions** tab, choose **Allow user to only assign selected roles to selected principals (fewer privileges)**, then **Select roles and principals** (wording may vary slightly).
     4. Choose the option that constrains **roles and principal types**:
        - **Roles:** **Storage Blob Data Contributor** and **Key Vault Secrets User**.
        - **Principal types:** **Service principals**.
     5. **Save** → **Review + assign**.
  5. Check: **Access control (IAM)** → **Role assignments** now lists `ATS GitHub deploy` twice. The second entry shows a condition.

### Step 1.8 – Create the Cloudflare Turnstile widget (the robot check)

- **Why:** the public application form shows a small "I'm not a robot" check (rule F6). In the codespace the app uses Cloudflare's fake test keys, which always pass. Azure needs real keys tied to the app's web address.
- **How:**
  1. Go to **dash.cloudflare.com** and sign up (free; no domain or card needed).
  2. In the left menu open **Turnstile** → **Add widget** (or **Add site**).
  3. **Widget name:** `ATS`.
  4. **Hostnames:** the real Azure address isn't known until Part 2. For now add the placeholder **`example.com`**; you'll replace it later.
  5. **Widget mode:** **Managed**. **Create**.
  6. Copy the **Site key** into section A (it's public; it appears in the web page) and the **Secret key** into section B.

### Step 1.9 – Create the GitHub key Azure uses to download the app (GHCR PAT)

- **Why:** the app image is stored privately in GHCR (rule G9). When Azure starts the app, it downloads the image and needs a key for that. GitHub only offers "classic" tokens for this. Give it **only** the `read:packages` permission, so the key can read packages and nothing else, and an expiry date.
- **How:**
  1. On github.com, click your profile picture (top right) → **Settings**.
  2. At the very bottom of the left menu: **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token** → **Generate new token (classic)**.
  3. **Note:** `ATS Azure image pull`. **Expiration:** **90 days**.
  4. **Select scopes:** tick **only `read:packages`**. Nothing else.
  5. **Generate token**, then copy the token (starts with `ghp_`) into section B. It is shown only once.
  6. Note the expiry date for a reminder.

### Step 1.10 – Store the non-secret values as GitHub Actions variables

- **Why:** the workflows read these settings when they run (task 44, owner setup step 3). They are IDs and names, not passwords. Claude's GitHub access can't set them, so you do it.
- **How:**
  1. On github.com open the `ats-app` repository → **Settings** → **Secrets and variables** → **Actions** → tab **Variables** → **New repository variable**.
  2. Create these variables. Names must match exactly, in capitals. The first nine are required; `POSTGRES_LOCATION` is needed only if your region refuses the cheap database size ([step 2.4](#step-24--full-dry-run-then-deploy)):

     | Name | Value |
     |---|---|
     | `AZURE_DEPLOY_CLIENT_ID` | Deploy app client ID (step 1.6) |
     | `AZURE_TENANT_ID` | Tenant ID (step 1.2) |
     | `AZURE_SUBSCRIPTION_ID` | Subscription ID (step 1.1) |
     | `AZURE_RESOURCE_GROUP` | e.g. `rg-ats-demo` (step 1.3) |
     | `GHCR_USERNAME` | `mikolajniezbecki-bit` |
     | `MICROSOFT_CLIENT_ID` | Sign-in app client ID (step 1.5) |
     | `TURNSTILE_SITE_KEY` | Turnstile site key (step 1.8) |
     | `DEMO_USER_DOMAIN` | Tenant domain, e.g. `yourname.onmicrosoft.com` (step 1.2) |
     | `BUDGET_ALERT_EMAIL` | The email that should receive cost alerts |
     | `POSTGRES_LOCATION` | Optional. Only if your region refuses the B1MS database (`SkuNotAvailable`): another EU region that offers it, e.g. `westeurope` |

  3. Make sure you used the **Variables** tab, **not Secrets**. The project rule is: no Azure secrets in GitHub.

**Then tell Claude:** "Part 1 is done", with your region and resource group name. Claude then builds task 44.

---

## Part 2, during task 44: building the cloud environment

Claude writes the Bicep files and the `infra.yml` workflow. A reviewer checks them and merges them into `main`. Only then can the workflow run. **Claude will tell you when it's ready.** The build happens in two stages (task 44, decision Q4):

- **Foundation:** creates the safe (Key Vault), file storage, logs, the app's identity and the budget. It can't create the app yet, because the app needs secrets that only you have.
- **Full:** after you put your secrets in the safe, creates the database, the web app and the scheduled jobs.

### How to run `infra.yml` (you'll do this several times)

1. On github.com open `ats-app` → **Actions** → in the left list **infra** → **Run workflow** (right side).
2. **Branch:** `main`. Fill in the inputs Claude asks for:
   - **mode:** `what-if` (dry run) or `deploy` (real);
   - **stage:** `foundation` or `full`;
   - **image_tag:** only when asked.
3. **Run workflow**. Wait for the green tick (or red cross) and open the run.
4. For a **what-if** run, open the **Summary** page. It lists what *would* be created, changed or deleted.
   - **Your approval:** read it, and if it matches what Claude described, start the matching **deploy** run. Choosing to start that run is your approval (task 44, your decision Q1).
   - If you see unexpected **deletions**, don't deploy; send Claude a screenshot.

### Step 2.0 – Switch on the Azure services the project uses (once)

- **Why:** a new subscription must "register" each kind of Azure service before anything of that kind can be created. Otherwise the deploy fails with `MissingSubscriptionRegistration`. Registering is a subscription-wide setting, so the deploy robot, whose rights cover only the resource group, can't do it. It's free.
- **How:**
  1. Open Cloud Shell (see [How to run an Azure command](#how-to-run-an-azure-command-cloud-shell)) and paste:

     ```sh
     for ns in Microsoft.App Microsoft.DBforPostgreSQL Microsoft.KeyVault Microsoft.ManagedIdentity Microsoft.OperationalInsights Microsoft.Storage Microsoft.Consumption; do az provider register --namespace $ns; done
     ```

  2. Wait 2–5 minutes, then paste this to check:

     ```sh
     for ns in Microsoft.App Microsoft.DBforPostgreSQL Microsoft.KeyVault Microsoft.ManagedIdentity Microsoft.OperationalInsights Microsoft.Storage Microsoft.Consumption; do echo "$ns $(az provider show --namespace $ns --query registrationState -o tsv)"; done
     ```

  3. Continue when every line ends in `Registered`. If some still say `Registering`, wait a minute and check again.

### Step 2.1 – Foundation: dry run, then deploy

- **Why:** creates the safe and the other basics, and generates the app's own random passwords (database, sign-in sessions, email fingerprints, scheduled job). Nobody, including you, ever has to type those.
- **How:**
  1. Run `infra.yml` with **mode `what-if`, stage `foundation`**. Check the summary.
  2. Run `infra.yml` with **mode `deploy`, stage `foundation`**. Wait for success.
  3. Tell Claude it succeeded (or send the error).

### Step 2.2 – Allow yourself to put secrets in the safe

- **Why:** the safe uses Azure permissions. Even as the subscription owner you first need the **Key Vault Secrets Officer** role on it to add secrets.
- **How:**
  1. In the portal open your resource group → click the **Key vault** resource (its name starts with the project prefix).
  2. **Access control (IAM)** → **+ Add** → **Add role assignment**.
  3. Find the role **Key Vault Secrets Officer** → **Next**.
  4. **+ Select members** → search your own account (the one you're signed in with) → **Select** → **Review + assign**.
  5. Wait about a minute for the permission to take effect.

### Step 2.3 – Put your three secrets in the safe

- **Why:** the app needs them at start:
  - the **sign-in secret**, to talk to Microsoft;
  - the **Turnstile secret**, to verify the robot check;
  - the **GHCR key**, to download its own image.

  The workflow deliberately never handles these (task 44 criterion); you add them yourself.
- **How (repeat three times):**
  1. In the key vault: **Objects** → **Secrets** → **+ Generate/Import**.
  2. **Upload options:** Manual. Fill in the **Name** exactly as below and paste the **Secret value** from section B of your notebook:

     | Name (exactly) | Value |
     |---|---|
     | `microsoft-client-secret` | the sign-in app's client secret value (step 1.5) |
     | `turnstile-secret-key` | the Turnstile secret key (step 1.8) |
     | `ghcr-pat` | the GHCR token (step 1.9) |

  3. Leave the other fields empty → **Create**.
  4. You'll also see secrets you didn't create (database passwords and others). The foundation stage generated them. **Don't change or delete them.**

### Step 2.4 – Full: dry run, then deploy

- **Why:** creates the database, the web app and the three jobs:
  - **`tick`:** hourly housekeeping, such as reminders and the retention purge;
  - **`db-migrate`:** updates the database structure;
  - **`db-seed`:** fills in starting data.
- **Before you start: the database region (only if your region refuses the database size).** A run fails with `SkuNotAvailable` ("Specified SKU is not supported in this region") when Azure won't give your subscription the cheap database size (B1MS) in the resource group's region. That happened in Poland Central. The database then goes in another EU region, and everything else stays where it is:
  1. **Choose the region.** Open Cloud Shell (see [How to run an Azure command](#how-to-run-an-azure-command-cloud-shell)) and run this for a few EU regions, for example `westeurope`, `swedencentral`, `northeurope` and `germanywestcentral`:
     ```sh
     az postgres flexible-server list-skus --location westeurope -o table
     ```
     Pick a region whose list includes **`Standard_B1ms`**.
  2. **Set the variable.** On github.com open `ats-app` → **Settings** → **Secrets and variables** → **Actions** → tab **Variables** → **New repository variable**. **Name:** `POSTGRES_LOCATION`. **Value:** the region, in lower case without spaces (e.g. `westeurope`). Use the **Variables** tab, not Secrets.
  3. **Delete the failed database.** The failed run may have left a database server (`ats-pg-…`) in the resource group, in a **Failed** state. If you see it, open it → **Delete**. It holds no data. If you forget, the next run stops and tells you to.
  4. Once a database exists, its region can't change. Don't edit `POSTGRES_LOCATION` afterwards: the run stops if the variable and the existing server don't match.
- **How:**
  1. Claude gives you the **image_tag** to use: the newest tested image, a long letters-and-digits code.
  2. Run `infra.yml` with **mode `what-if`, stage `full`, image_tag `<that code>`**. Check the summary. In the run's **Read the current state** step, check the line `PostgreSQL region: <region>`: it should show the region you chose (or the resource group's region if you didn't set `POSTGRES_LOCATION`).
  3. Run it again with **mode `deploy`**, same stage and tag. This takes a while (the database alone can take 10–15 minutes). At the end the workflow prepares the database and checks that the app answers.
  4. Tell Claude the result. Claude reads the app's new web address from the run, something like `https://ats-web-xxxx.<region>.azurecontainerapps.io`, and gives it to you.

### Step 2.5 – Tell Microsoft and Cloudflare the app's real address

- **Why:** the address only exists after the full deployment (task 44, decision Q12). For security, both services only work with addresses you list:
  - Microsoft sends users back after sign-in only to listed addresses;
  - Turnstile shows its check only on listed hostnames.
- **How:**
  1. **Microsoft:** **Microsoft Entra ID** → **App registrations** → `ATS sign-in` → **Authentication** → under **Web** → **Redirect URIs**, add `https://<app address>/api/auth/callback/microsoft`. Use the exact address Claude gave you. **Save**. Keep the `localhost` entry.
  2. **Cloudflare:** **Turnstile** → widget `ATS` → **Settings** (or **Edit**) → **Hostnames**: add the host name **without** `https://` and without anything after it, e.g. `ats-web-xxxx.westeurope.azurecontainerapps.io`. Remove `example.com`. **Save**.
- **Repeat this step** whenever the environment is rebuilt from scratch, because the address can change.

### Step 2.6 – Set reminders

- **Why:** keys with an expiry silently stop working when they expire:
  - the expired GHCR token stops Azure from downloading new images;
  - the expired sign-in secret stops staff sign-in.
- **How:** add two calendar reminders, about two weeks before each expiry date (GHCR token: in 90 days; sign-in secret: the date you chose). See [Ongoing](#ongoing-reminders-and-stopping-the-database-between-demos) for how to renew.

**Task 44 is finished when:**

- a what-if run and a deploy run worked;
- the reviewer has checked the deployed settings (log cap, budget, no test-only settings in Azure);
- a second deploy changes nothing.

Claude handles the checks and may ask you for one or two more runs.

---

## Part 3, during task 45: going live and checking it by hand

From task 45 on, every merge into `main` updates Azure automatically. Nothing to click for that. You do need to start the demo data once, and do some checks in a browser that only a human can do (task 45's "cloud proofs").

### How to run an Azure command (Cloud Shell)

A few steps ask you to run a command:

1. Open **portal.azure.com** and click the **Cloud Shell** icon (a small `>_` in the top bar).
2. Choose **Bash**. The first time, choose **No storage account required** (or let it create a small one) and your subscription.
3. Paste the command Claude gives you, press **Enter**, and copy the output back to Claude. Outputs don't contain secrets unless Claude says so; if anything looks like a password, don't paste it.

### Step 3.1 – Fill the app with demo data and make yourself Admin

- **Why:** the app starts empty. The `db-seed` job adds:
  - the settings, the four demo staff users (matching your Microsoft accounts from step 1.4), and a fictitious demo set (requisitions, applications, CVs, interviews, offers; task 42);
  - in a second run, **you** as the first Admin (rule AU8).
- **How:** Claude gives you two Cloud Shell commands (also in the README section that task 44 writes). Run them one after the other and send Claude the outputs. The second one includes your UPN `owner@yourname.onmicrosoft.com`.

### Step 3.2 – Sign in with each demo account (proof #6)

- **Why:** sign-in with real Microsoft accounts can't be tested automatically. This proves the invite-only rule: known users get in, others don't (rules AU2–AU5).
- **How:** use a **private/incognito browser window** for each account, so earlier sign-ins don't interfere.
  1. Open the app address → **Sign in with Microsoft**.
  2. Sign in as `owner@…`, choose a new password when asked, and set up Authenticator if asked. You should land on the dashboard as **Admin**.
  3. Repeat with `admin@`, `recruiter@`, `hm@` and `interviewer@`. Each should land on the dashboard showing its role. Note what you see:
     - Hiring Manager: approvals waiting;
     - Interviewer: a scorecard to fill.
  4. Sign out and sign in again with one of them; it should still work.
  5. Sign in as **`outsider@`**. You should see **"Access not granted, contact your ATS admin."**
  6. As `owner@` (Admin) in the app: **Admin → Users** → create a user with email `throwaway@yourname.onmicrosoft.com` (any role). In another private window, sign in as `throwaway@`; it works. Then, as Admin, **deactivate** that user. The `throwaway@` window should stop working on the next click, and a new sign-in should show the "Access not granted" message.
- **Send Claude:**
  - "proof 6 OK", or what went wrong;
  - optionally screenshots **without** passwords or personal data.

### Step 3.3 – Open a CV, look at the Outbox, try the robot check (proofs #7, #8 and Turnstile)

- **Why:** these features depend on Azure-only services: secure links to the file storage, the email Outbox, and the real Turnstile keys. Claude checks the technical details. You confirm what a user sees.
- **How:**
  1. **Proof #7, CV:** as `recruiter@`, open any demo application and check that the CV shows inside the page.
  2. **Proof #8, Outbox:** Claude will ask you to do a short sequence:
     - as `recruiter@`, schedule an interview on a demo application;
     - as `hm@`, approve a waiting offer;
     - then, as `owner@` (Admin), open **Admin → Outbox**. You should see the interview invitation (with a calendar file to download) and the offer email (with a PDF you can open).

     No email is really sent anywhere (rule C4).
  3. **Turnstile:** open the public job board (`/jobs` on the app address) in a normal window, open a job, and check that the robot check appears on the application form. Submit an application with made-up data, e.g. name "Test Person" and email `test@example.com`, and a small PDF (Claude can give you one). You should see the thank-you page. **Use made-up data only** (rule C3).
- **Send Claude:** "proofs 7/8/Turnstile OK", or what went wrong.

### Step 3.4 – Help with the remaining technical checks if asked

- **Proof #9 (which client IP header Azure provides):** Claude sends a few test requests and reads the logs. This may need you to paste one or two read-only commands into Cloud Shell.
- **Rebuild check:** the README gains a "rebuild from an empty resource group" procedure. The first build you did in Part 2 counts as its proof (task 45, Q6). Nothing extra unless a step there didn't work as written.

### Step 3.5 – Test stopping and starting the database once

- **Why:** after 12 months the database is no longer free. Stopping it (and the hourly job) between demos keeps the cost near zero (rule G10). This step proves the procedure works.
- **How:**
  1. Run Claude's **stop** commands in Cloud Shell. Then **wait about 2 hours**: the proof is that the hourly job doesn't run while stopped.
  2. Run the **start** commands. Tell Claude, who checks that the next hourly run succeeds and the app answers.
- **Good to know:**
  - Azure automatically restarts a stopped database after **7 days**. To keep it stopped longer, stop it again.
  - While it is stopped, deployments fail with a clear message. Start it first.

---

## Part 4, during task 46: final tests

Task 46 adds complete end-to-end test journeys for every role and makes the rule-coverage check strict. It runs entirely in GitHub and the codespace. **No setup is needed from you.**

- Claude may ask you to **decide** something if a rule turns out to be unclear or impossible to test as written (task 46, Q3). Answer in chat.
- If you want, keep an eye on **GitHub Actions minutes**: github.com → profile picture → **Settings** → **Billing and plans** → **Plans and usage**. The free plan includes 2,000 minutes per month, and each push to `main` uses roughly 30. Running out doesn't cost money; it only pauses the automation until the next month.

---

## Ongoing: reminders and stopping the database between demos

| When | What | How |
|---|---|---|
| ~2 weeks before the GHCR token expires (every 90 days) | Renew the image-download key | Step 1.9 again (new classic token, `read:packages` only), then in the key vault open `ghcr-pat` → **+ New Version** → paste the new token. Delete the old token in GitHub. |
| ~2 weeks before the sign-in secret expires | Renew the sign-in secret | Step 1.5 point 7 again (new client secret), then key vault → `microsoft-client-secret` → **+ New Version**. Delete the old secret in the app registration afterwards. |
| One week after going live, then monthly | Check costs | Portal → **Cost Management** → **Cost analysis**, scope your resource group. It should be close to zero. |
| Between demos (especially after month 12) | Stop the database and the hourly job | The README "Stop and start between demos" commands (task 45), in Cloud Shell. |
| If you ever delete the resource group and rebuild | Follow the README rebuild procedure | It includes recovering or purging the deleted key vault, and step 2.5 again for the new address. |

If a budget alert email arrives (80 % or 100 % of EUR 10), tell Claude. **The alert only informs you; it never stops anything** (rule M8). Stopping the database is what saves money.

---

## Costs and what protects you

- **First 30 days:** covered by the free starter credit (USD 200).
- **Months 1–12:**
  - **Close to zero overall.** The project uses only free or near-free settings.
  - **Database and web app:** the small database (B1MS, 32 GB) is free for 12 months, and the web app sleeps when unused.
  - **Logs:** capped at 0.1 GB per day.
  - **Safe and file storage:** cost cents.
- **After month 12:** the database is billed by the hour. Stop it between demos (step 3.5).
- **Protections:**
  - the budget alert at EUR 10;
  - the log cap;
  - no automatic scaling beyond one copy of the app;
  - all paid "extras" switched off: high availability, geo-backups and automatic storage growth on the database, and soft delete on the file storage (so deleted CVs are really gone).
  - Leave **Microsoft Defender for Cloud** on its free tier if Azure suggests upgrading.
- **What would cost money:** turning on any paid extra, creating a second database, or leaving the database running after month 12. Claude won't do any of these without asking you.

---

## Summary checklist

**Part 1, now (before task 44):**
- [ ] 1.1 Azure account created; subscription ID noted
- [ ] 1.2 Tenant ID and tenant domain noted
- [ ] 1.3 Region chosen; resource group created
- [ ] 1.4 Seven directory users created (`owner`, `admin`, `recruiter`, `hm`, `interviewer`, `outsider`, `throwaway`); passwords kept safe
- [ ] 1.5 `ATS sign-in` app registration: client ID noted, client secret saved, optional `email` claim added
- [ ] 1.6 `ATS GitHub deploy` app registration with the `main`-branch federated credential; client ID noted
- [ ] 1.7 Contributor + restricted RBAC Administrator given to `ATS GitHub deploy` on the resource group
- [ ] 1.8 Turnstile widget created (placeholder hostname); site key noted, secret key saved
- [ ] 1.9 GHCR classic token (`read:packages` only, 90 days) saved
- [ ] 1.10 Nine GitHub Actions **variables** set (plus `POSTGRES_LOCATION` only if needed)
- [ ] Told Claude "Part 1 is done" with the region and resource group

**Part 2, when Claude says `infra.yml` is ready (task 44):**
- [ ] 2.0 Azure services registered in the subscription (all `Registered`)
- [ ] 2.1 Foundation: what-if, then deploy
- [ ] 2.2 Key Vault Secrets Officer for yourself
- [ ] 2.3 Three secrets added to Key Vault
- [ ] 2.4 Only if `SkuNotAvailable`: database region chosen, `POSTGRES_LOCATION` variable set, failed database server deleted
- [ ] 2.4 Full: what-if, then deploy (with the image tag from Claude); `PostgreSQL region` line checked
- [ ] 2.5 Redirect URI added in Entra; real hostname set in Turnstile
- [ ] 2.6 Calendar reminders for the token and the sign-in secret

**Part 3, when Claude says deployment is live (task 45):**
- [ ] 3.1 `db-seed` job run twice (demo data, then you as Admin)
- [ ] 3.2 Sign-in checks with all accounts, including `outsider` and `throwaway`
- [ ] 3.3 CV, Outbox and robot-check checks
- [ ] 3.4 Help with technical checks if asked
- [ ] 3.5 Stop/start test (about 2 hours of waiting)

**Part 4 (task 46):**
- [ ] Nothing to set up; answer questions if asked
