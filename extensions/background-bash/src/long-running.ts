// Commands known to run long move to the background before they start, so the agent never
// blocks on them. The decision is deterministic; the model cannot opt out.

type Rule = { label: string; pattern: RegExp };

const END = String.raw`(?:\s|$)`;
const PACKAGE_MANAGER = String.raw`(?:npm|pnpm|yarn|bun)`;
// Package-manager options before the subcommand, such as `--filter app` or `-r`.
const PM_OPTIONS = String.raw`(?:\s+-\S+(?:\s+[^-\s]\S*)?)*`;
const pmScript = (names: string): RegExp =>
  new RegExp(
    String.raw`^${PACKAGE_MANAGER}${PM_OPTIONS}\s+(?:run(?:-script)?\s+)?(?:${names})(?:[:._-]\S*)?${END}`,
  );
const pmCommand = (names: string): RegExp =>
  new RegExp(String.raw`^${PACKAGE_MANAGER}${PM_OPTIONS}\s+(?:${names})${END}`);
const words = (list: string, suffix = END): RegExp => new RegExp(String.raw`^(?:${list})${suffix}`);

const TEST_WORDS = String.raw`tests?|t|e2e|integration|unit|coverage|cov|ci|check|verify|validate|spec|specs|acceptance|smoke|regression|all`;
const SYSTEM_PATH = String.raw`(?:/|~/?|\$HOME/?|\$\{HOME\}/?|/Users/?|/home/?|/System/?|/Library/?|/Volumes/?|/usr/?|/opt/?|/var/?|/private/?)`;

const RULES: Rule[] = [
  // Test suites, including runners reached through task runners and test scripts.
  { label: "test suite", pattern: words(String.raw`pytest|py\.test|tox|nox|nose2|nosetests|behave|robot|unittest|green|ward|trial|coverage\s+run|hatch\s+test`) },
  { label: "test suite", pattern: /^(?:\S*\/)?manage\.py\s+test(?:\s|$)/ },
  { label: "test suite", pattern: /^django-admin\s+test(?:\s|$)/ },
  {
    label: "test suite",
    pattern: words(
      String.raw`vitest|jest|mocha|ava|karma|jasmine|tap|tape|c8|nyc|uvu|wdio|testcafe|nightwatch|detox\s+test|playwright\s+test|cypress\s+run|cucumber-js|cucumber|stryker\s+run|elm-test|bun\s+test|deno\s+test`,
    ),
  },
  { label: "test suite", pattern: pmScript(TEST_WORDS) },
  { label: "test suite", pattern: pmCommand("test|t|cit|install-test") },
  { label: "test suite", pattern: /^(?:go|cargo)\s+(?:test|bench|nextest|tarpaulin|llvm-cov|mutants|fuzz)(?:\s|$)/ },
  {
    label: "test suite",
    pattern: /^(?:mix|dart|flutter|swift|zig|dune|dotnet|stack|cabal|gleam|meson|lein|sbt|xcodebuild|bazel|bazelisk|buck2?|pants)\s+(?:\S+\s+)*?test(?:\s|$)/,
  },
  { label: "test suite", pattern: words(String.raw`(?:\S*\/)?(?:rspec|ctest|phpunit|pest|paratest|codecept|minitest|prove|busted|bats|shellspec|kuttl|venom)`) },
  { label: "test suite", pattern: /^(?:bin\/)?(?:rails|rake)\s+(?:test|spec)(?::\S*)?(?:\s|$)/ },
  { label: "test suite", pattern: /^php\s+artisan\s+test(?:\s|$)/ },
  {
    label: "test suite",
    pattern: new RegExp(
      String.raw`^(?:make|gmake|just|task|go-task|mise\s+(?:run|r)|cargo\s+make|invoke|inv|doit|poe|pdm\s+run|hatch\s+run|rye\s+run|earthly|dagger\s+(?:call|run))(?:\s+-\S+)*\s+(?:\S+\s+)*?[\w:./+-]*(?:${TEST_WORDS})[\w:./+-]*${END}`,
    ),
  },
  { label: "test suite", pattern: /^(?:\S*\/)?(?:run[-_]?)?(?:tests?|specs?|ci|e2e|integration|check)(?:[-_.][\w.-]*)?\.(?:sh|bash|py|rb|js|mjs|ts|ps1)(?:\s|$)/ },
  { label: "test suite", pattern: /^(?:\.{1,2}\/|\S+\/)(?:run[-_]?)?(?:tests?|specs?|ci|e2e|integration|check)(?:[-_][\w-]*)?(?:\s|$)/ },
  { label: "test suite", pattern: /^(?:pre-commit\s+run|lefthook\s+run|act|tox\s+run)(?:\s|$)/ },
  { label: "type check", pattern: words(String.raw`mypy|dmypy|pyright|basedpyright|pyre|pytype|tsc|vue-tsc|svelte-check|flow\s+check`) },
  {
    label: "repository-wide check",
    pattern: words(String.raw`golangci-lint\s+run|semgrep|trivy|grype|snyk\s+test|sonar-scanner|codeql|pylint|bandit\s+-r|gitleaks|trufflehog|staticcheck|cargo\s+audit|npm\s+audit|pip-audit|safety\s+check`),
  },
  { label: "repository-wide check", pattern: /^(?:eslint|prettier|stylelint|rubocop|flake8|tslint)\b(?:.*\s)?(?:\.|\.\/|src\/?|lib\/?|app\/?)(?:\s|$)/ },

  // Builds.
  { label: "build", pattern: words(String.raw`(?:\S*\/)?(?:mvnw?|gradlew?|sbt|lein|ant|bazel|bazelisk|buck2?|pants|please)`) },
  { label: "build", pattern: words(String.raw`make|gmake|ninja|scons|meson\s+(?:compile|setup)|cmake|xcodebuild|msbuild|cargo\s+make|earthly|lake\s+build`) },
  { label: "build", pattern: /^cargo\s+(?:build|check|clippy|doc|install|run|update|fetch|publish|bench)(?:\s|$)/ },
  { label: "build", pattern: /^go\s+(?:build|install|generate|vet|run|mod\s+(?:download|tidy|vendor))(?:\s|$)/ },
  {
    label: "build",
    pattern: pmScript(String.raw`build|compile|bundle|package|dist|release|typecheck|type-check|types|tsc|lint|format|fmt|prepare|prepack|generate|gen|codegen|export|docs`),
  },
  {
    label: "build",
    pattern: /^(?:next|nuxt|nuxi|vite|astro|svelte-kit|remix|react-router|ng|webpack|rollup|esbuild|parcel|tsup|unbuild|electron-builder|electron-forge|expo|eas|gatsby|docusaurus)\s+(?:build|export|prerender|make|package|publish|generate)(?:\s|$)/,
  },
  { label: "build", pattern: words(String.raw`webpack|rollup|parcel|hugo|jekyll\s+build|mkdocs\s+build|sphinx-build|zola\s+build|mdbook\s+build`) },
  {
    label: "build",
    pattern: /^(?:turbo(?:\s+run)?|nx(?:\s+(?:run|run-many|affected|build|test|lint|e2e))?|lerna\s+run|rush\s+(?:build|rebuild|test)|moon\s+(?:run|ci|check))(?:\s|$)/,
  },
  { label: "build", pattern: /^(?:dotnet|swift|flutter|dart|mix|gleam)\s+(?:build|publish|restore|run|pub\s+get|compile|deps\.get|deps\.compile|release)(?:\s|$)/ },
  { label: "build", pattern: words(String.raw`build|hatch\s+build|poetry\s+build|uv\s+build|flit\s+build|maturin\s+(?:build|develop)|pip[0-9.]*\s+wheel|pyinstaller|nuitka|cibuildwheel|setup\.py\s+(?:build|bdist_wheel|sdist|install)`) },
  { label: "build", pattern: /^(?:stack|cabal)\s+(?:build|install)(?:\s|$)/ },

  // Containers and infrastructure.
  {
    label: "container",
    pattern:
      /^(?:docker|podman|nerdctl|finch)\s+(?:build|buildx|pull|push|run|load|save|import|export|commit|image\s+(?:build|pull|push)|container\s+run|system\s+prune|builder\s+prune|volume\s+prune|scout)(?:\s|$)/,
  },
  { label: "container", pattern: /^(?:docker\s+compose|docker-compose|podman-compose|podman\s+compose)(?:\s+-\S+(?:\s+[^-\s]\S*)?)*\s+(?:up|build|pull|push|run|create|restart|start|watch)(?:\s|$)/ },
  { label: "container", pattern: words(String.raw`buildah|kaniko|skopeo\s+copy|kind\s+create|minikube\s+start|colima\s+start|k3d\s+cluster\s+create|devcontainer\s+(?:up|build)|lima(?:ctl)?\s+start|multipass\s+launch`) },
  {
    label: "infrastructure",
    pattern:
      /^(?:(?:terraform|tofu|terragrunt)\s+(?:init|plan|apply|destroy|import|refresh|run-all|test)|pulumi\s+(?:up|preview|destroy|refresh)|cdk\s+(?:deploy|synth|destroy|diff)|sam\s+(?:build|deploy)|serverless\s+deploy|sls\s+deploy|ansible-playbook|ansible|packer\s+build|vagrant\s+(?:up|provision|reload|destroy))(?:\s|$)/,
  },
  { label: "infrastructure", pattern: /^(?:kubectl|oc)\s+(?:rollout\s+status|wait|drain|port-forward)(?:\s|$)/ },
  { label: "infrastructure", pattern: /^helm\s+(?:install|upgrade|test|dependency\s+(?:build|update))(?:\s|$)/ },
  {
    label: "deploy",
    pattern:
      /^(?:gcloud\s+(?:builds\s+submit|run\s+deploy|app\s+deploy|functions\s+deploy|compute\s+(?:ssh|scp))|aws\s+s3\s+(?:sync|cp|mv)|gsutil(?:\s+-m)?\s+(?:cp|rsync|mv)|rclone\s+(?:copy|sync|move|mount|bisync)|azcopy|fly(?:ctl)?\s+deploy|netlify\s+deploy|wrangler\s+(?:deploy|publish|pages\s+deploy)|heroku\s+(?:builds|run)|railway\s+up|render\s+deploy|firebase\s+deploy|eb\s+deploy|copilot\s+deploy)(?:\s|$)/,
  },
  { label: "deploy", pattern: /^vercel(?:\s+(?:deploy|build|--prod)(?:\s.*)?)?$/ },

  // Dependency installs.
  { label: "install", pattern: pmCommand("install|i|ci|add|update|up|upgrade|rebuild|dedupe|outdated|link|create|init") },
  { label: "install", pattern: /^(?:yarn|bun|pnpm)$/ },
  { label: "install", pattern: /^(?:pip[0-9.]*|uv\s+pip)\s+(?:install|download|sync|compile)(?:\s|$)/ },
  { label: "install", pattern: words(String.raw`pip-compile|pip-sync|pipx\s+(?:install|upgrade|reinstall|run)`) },
  { label: "install", pattern: /^uv\s+(?:sync|add|lock|remove|venv|tool\s+(?:install|upgrade)|python\s+install)(?:\s|$)/ },
  { label: "install", pattern: /^(?:poetry|pipenv|pdm|rye|hatch)\s+(?:install|add|update|lock|sync|env\s+create)(?:\s|$)/ },
  { label: "install", pattern: /^(?:conda|mamba|micromamba)\s+(?:install|create|update|upgrade|env\s+(?:create|update))(?:\s|$)/ },
  { label: "install", pattern: /^(?:brew\s+(?:install|upgrade|update|reinstall|bundle|tap|cleanup|doctor)|port\s+(?:install|upgrade|selfupdate)|mas\s+(?:install|upgrade))(?:\s|$)/ },
  { label: "install", pattern: /^(?:apt|apt-get|aptitude|dnf|yum|zypper|apk|snap|flatpak)(?:\s+-\S+)*\s+(?:install|upgrade|update|dist-upgrade|full-upgrade|add|refresh|reinstall)(?:\s|$)/ },
  { label: "install", pattern: /^(?:pacman|yay|paru)\s+-S/ },
  { label: "install", pattern: /^bundle(?:\s+(?:install|update)(?:\s.*)?)?$/ },
  {
    label: "install",
    pattern: /^(?:gem\s+(?:install|update)|composer\s+(?:install|update|require|create-project)|pod\s+(?:install|update|repo\s+update)|carthage\s+(?:update|bootstrap)|cpanm|luarocks\s+install|opam\s+(?:install|update|upgrade)|nimble\s+install|cargo\s+binstall|go\s+get)(?:\s|$)/,
  },
  { label: "install", pattern: /^(?:nix\s+(?:build|develop|shell|profile\s+install|flake\s+update|run)|nix-build|nix-shell|nix-env\s+-i|home-manager\s+switch|darwin-rebuild|nixos-rebuild)(?:\s|$)/ },
  {
    label: "install",
    pattern: /^(?:asdf\s+install|mise\s+(?:install|upgrade)|rtx\s+install|rustup\s+(?:update|toolchain\s+install)|sdk\s+install|nvm\s+install|fnm\s+install|pyenv\s+install|rbenv\s+install|volta\s+install|corepack\s+(?:prepare|install)|playwright\s+install|puppeteer\s+browsers\s+install)(?:\s|$)/,
  },
  { label: "install", pattern: /^(?:create-react-app|create-next-app|create-vite|cookiecutter|copier\s+copy|rails\s+new|django-admin\s+startproject|cargo\s+new|dotnet\s+new)(?:\s|$)/ },

  // Database migrations and data loads.
  { label: "migration", pattern: /^alembic\s+(?:upgrade|downgrade|stamp|revision)(?:\s|$)/ },
  { label: "migration", pattern: /^(?:\S*\/)?manage\.py\s+(?:migrate|makemigrations|loaddata|dumpdata|collectstatic|flush|rebuild_index|update_index|compress)(?:\s|$)/ },
  { label: "migration", pattern: /^django-admin\s+(?:migrate|makemigrations|loaddata)(?:\s|$)/ },
  { label: "migration", pattern: /^prisma\s+(?:migrate|db\s+(?:push|seed|pull)|generate)(?:\s|$)/ },
  { label: "migration", pattern: /^(?:bin\/)?(?:rails|rake)\s+db:\S+/ },
  { label: "migration", pattern: pmScript(String.raw`migrate|migration|migrations|db|seed|db-\S+|prisma`) },
  {
    label: "migration",
    pattern:
      /^(?:knex|sequelize|sequelize-cli|typeorm|drizzle-kit|mikro-orm|node-pg-migrate|db-migrate|flyway|liquibase|goose|migrate|dbmate|diesel\s+migration|sqlx\s+migrate|atlas\s+(?:migrate|schema\s+apply)|sqitch|yoyo|php\s+artisan\s+(?:migrate|db:seed)|artisan\s+(?:migrate|db:seed)|supabase\s+db\s+(?:push|reset|pull))(?:\s|$)/,
  },
  { label: "database", pattern: words(String.raw`pg_dump|pg_restore|pg_dumpall|pg_basebackup|mysqldump|mysqlpump|mongodump|mongorestore|mongoimport|mongoexport|vacuumdb|reindexdb|clickhouse-client\s+--query`) },

  // Servers and watchers never finish on their own.
  { label: "server or watcher", pattern: pmScript(String.raw`dev|start|serve|server|watch|preview|storybook|emulators|tauri\s+dev`) },
  { label: "server or watcher", pattern: pmCommand("start") },
  {
    label: "server or watcher",
    pattern: /^(?:next|nuxt|nuxi|astro|remix|react-router|vite|svelte-kit|expo|wrangler|netlify|vercel|tauri|electron-forge|vitepress|docusaurus|gatsby|eleventy|wxt|plasmo)\s+(?:dev|start|preview|serve|develop)(?:\s|$)/,
  },
  { label: "server or watcher", pattern: /^(?:vite|ng\s+serve|storybook|webpack-dev-server|webpack\s+serve|tsc\s+(?:.*\s)?(?:-w|--watch))(?:\s|$)/ },
  {
    label: "server or watcher",
    pattern: words(
      String.raw`uvicorn|gunicorn|hypercorn|daphne|granian|waitress-serve|celery|rq\s+worker|dramatiq|huey_consumer|flask\s+run|fastapi\s+(?:dev|run)|streamlit\s+run|gradio|panel\s+serve|jupyter(?:-lab)?\s+(?:lab|notebook|server)|jupyter-lab|voila|http\.server|http-server|serve|live-server|browser-sync|nodemon|ts-node-dev|tsx\s+watch|node\s+--watch|bun\s+--watch|bun\s+--hot|deno\s+(?:run\s+--watch|serve)|air|reflex|watchexec|entr|cargo\s+watch|bacon|(?:bin\/)?rails\s+(?:server|s)|php\s+artisan\s+(?:serve|queue:work|horizon)|php\s+-S|hugo\s+server|jekyll\s+serve|mkdocs\s+serve|sphinx-autobuild|ngrok|cloudflared\s+tunnel|tailscale\s+(?:serve|funnel)|firebase\s+emulators:start|supabase\s+start|localstack\s+start|redis-server|mongod|postgres|caddy\s+run|nginx\s+-g|mitmweb`,
    ),
  },
  { label: "server or watcher", pattern: /^(?:\S*\/)?manage\.py\s+(?:runserver|runworker|celery|shell_plus\s+--notebook)(?:\s|$)/ },
  { label: "server or watcher", pattern: /^(?:docker|podman)\s+(?:compose\s+)?(?:logs|events)\b.*\s(?:-f|--follow)(?:\s|$)|^(?:docker|podman)\s+(?:stats|events)(?:\s|$)/ },
  { label: "server or watcher", pattern: /^(?:kubectl|oc|stern)\s+(?:logs|get)?\b.*\s(?:-f|--follow|-w|--watch)(?:\s|$)|^stern(?:\s|$)/ },
  { label: "server or watcher", pattern: /^(?:tail\s+(?:.*\s)?(?:-[a-zA-Z]*[fF][a-zA-Z]*|--follow(?:=\S+)?)|less\s+\+F|journalctl\s+(?:.*\s)?(?:-f|--follow)|log\s+stream|watch|htop|top|btop|glances|iotop|nethogs|iftop)(?:\s|$)/ },

  // Waiting on remote state.
  { label: "wait or poll", pattern: /^gh\s+(?:run\s+watch|pr\s+checks\s+(?:.*\s)?--watch|workflow\s+run\s+(?:.*\s)?--watch|codespace\s+ssh)(?:\s|$)/ },
  { label: "wait or poll", pattern: /^glab\s+ci\s+(?:status\s+(?:.*\s)?--live|trace)(?:\s|$)/ },
  { label: "wait or poll", pattern: /^sleep\s+(?:\d*[5-9]|\d{2,})(?:\.\d+)?s?(?:\s|$)|^sleep\s+\d+(?:\.\d+)?[mhd](?:\s|$)/ },
  { label: "wait or poll", pattern: /^(?:wait|until)(?:\s|$)/ },
  { label: "wait or poll", pattern: /^while\s+(?:true|:|\[\s*1\s*\]|sleep|!)(?:\s|$)/ },
  { label: "wait or poll", pattern: words(String.raw`wait-for-it|wait-for|wait-on|dockerize\s+-wait|aws\s+\S+\s+wait|az\s+\S+\s+wait|gcloud\s+.*--async|kubectl\s+wait`) },

  // Remote sessions and network diagnostics.
  {
    label: "remote or network",
    pattern: words(
      String.raw`ssh|scp|sftp|rsync|mosh|ssh-copy-id|sshpass|autossh|ping6?|mtr|traceroute6?|tracepath|tcpdump|tshark|termshark|nmap|masscan|zmap|iperf3?|speedtest(?:-cli)?|networkQuality|fping|hping3|arping|arp-scan|nc\s+(?:.*\s)?-[a-zA-Z]*l|ncat\s+(?:.*\s)?-[a-zA-Z]*l|socat|telnet|ftp|lftp|mitmproxy|mitmdump|bettercap|dig\s+.*\+trace|whois|nslookup\s+-type=any`,
    ),
  },
  { label: "remote or network", pattern: /^(?:kubectl|oc)\s+(?:exec|cp|debug|attach|run)(?:\s|$)/ },
  { label: "remote or network", pattern: /^(?:aws\s+ssm\s+start-session|az\s+ssh|gcloud\s+cloud-shell\s+ssh|tailscale\s+(?:ping|netcheck|up)|wg-quick|openvpn|wireguard-go)(?:\s|$)/ },

  // Heavy downloads, media, and model work.
  {
    label: "download or heavy processing",
    pattern: words(
      String.raw`git\s+(?:clone|lfs\s+(?:pull|fetch|clone|migrate)|gc|repack|fsck|submodule\s+update|filter-repo|filter-branch|bisect\s+run|maintenance\s+run)|wget|aria2c|axel|curl\s+(?:.*\s)?-[a-zA-Z]*O|yt-dlp|youtube-dl|gallery-dl|ffmpeg|HandBrakeCLI|sox|whisper|whisper-cli|whisper-cpp|faster-whisper|insanely-fast-whisper|ollama\s+(?:pull|run|create|push|serve)|huggingface-cli\s+(?:download|upload)|hf\s+(?:download|upload)|llama-cli|llama-server|llama-bench|vllm\s+serve|mlx_lm\.(?:generate|server|lora|convert)|mlx_whisper|dvc\s+(?:pull|push|repro|exp\s+run)|kaggle\s+(?:datasets|competitions)\s+download|accelerate\s+launch|torchrun|deepspeed|tensorboard|wandb\s+sweep|julia|R\s+CMD|Rscript|octave|matlab`,
    ),
  },
  { label: "download or heavy processing", pattern: words(String.raw`dd|hdiutil|createinstallmedia|softwareupdate|tmutil\s+(?:startbackup|restore|verifychecksums)|diskutil\s+(?:secureErase|zeroDisk|eraseDisk|verifyVolume|repairVolume)|shred|srm|photorec|testdisk|fsck(?:\.\S+)?|e2fsck|badblocks|smartctl\s+-t|tar\s+(?:.*\s)?-?[a-zA-Z]*c|zip\s+-r|7z\s+a|zstd\s+-\d{2}|xz\s+-[6-9]`) },
  { label: "download or heavy processing", pattern: /^(?:jupyter\s+(?:nbconvert\s+(?:.*\s)?--execute|execute)|papermill|nbmake|quarto\s+render|pandoc\s+(?:.*\s)?--pdf-engine)(?:\s|$)/ },

  // Benchmarks and load tests.
  {
    label: "benchmark",
    pattern: words(
      String.raw`hyperfine|ab|wrk|wrk2|k6|locust|vegeta|artillery|siege|bombardier|oha|hey|jmeter|gatling|sysbench|fio|stress|stress-ng|pgbench|redis-benchmark|memtier_benchmark|asv\s+run|pytest-benchmark|criterion|perf\s+(?:record|stat)|valgrind|heaptrack|py-spy\s+record|austin|scalene|memray\s+run`,
    ),
  },
  { label: "benchmark", pattern: pmScript(String.raw`bench|benchmark|benchmarks|perf|profile|load-test|loadtest|stress`) },

  // Searches over the whole disk or home directory.
  {
    label: "disk-wide scan",
    pattern: new RegExp(
      String.raw`^(?:find|fd|fdfind|du|ncdu|dust|gdu|rg|ag|ack|grep|egrep|fgrep|tree|ls\s+-[a-zA-Z]*R|mdfind|locate|clamscan|chmod\s+-R|chown\s+-R|chflags\s+-R|xattr\s+-r|codesign\s+--deep|spctl\s+--assess|rm\s+-[a-zA-Z]*r[a-zA-Z]*|cp\s+-[a-zA-Z]*R[a-zA-Z]*|mv)\b(?:.*\s)?${SYSTEM_PATH}${END}`,
    ),
  },
  { label: "disk-wide scan", pattern: words(String.raw`updatedb|mdutil\s+-E|freshclam|clamscan\s+-r|softwareupdate\s+-l|system_profiler|sysdiagnose|bleachbit|mole\s+(?:clean|analyze)`) },
];

const VERSION_OR_HELP = /\s(?:--version|-V|--help|-h|help|version)$/;

// Wrappers that run another command; strip them so the wrapped command is classified.
const WRAPPERS: RegExp[] = [
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/,
  /^(?:do|then|else|elif|if|!|\{|time|command|builtin|exec|nohup|xvfb-run(?:\s+-a)?|unbuffer|chronic|ts|pv)\s+/,
  /^caffeinate(?:\s+-[dimsu]+|\s+-[tw]\s+\S+)*\s+/,
  /^sudo(?:\s+(?:-[ugCDhpRrTt]\s+\S+|--\S+|-[a-zA-Z]+))*\s+/,
  /^doas(?:\s+(?:-u\s+\S+|-[a-zA-Z]+))*\s+/,
  /^env(?:\s+(?:-u\s+\S+|-C\s+\S+|-S|-i|-\S+|[A-Za-z_][A-Za-z0-9_]*=\S*))*\s+/,
  /^nice(?:\s+(?:-n\s+\S+|-\S+))*\s+/,
  /^(?:ionice|taskpolicy|chrt|taskset|numactl|cpulimit|firejail|bwrap|sandbox-exec(?:\s+-[fp]\s+\S+)?)(?:\s+(?:-[a-zA-Z]\s+\S+|--\S+|-\S+))*\s+/,
  /^stdbuf(?:\s+-\S+)*\s+/,
  /^g?timeout(?:\s+(?:-[sk]\s+\S+|--\S+|-\S+))*\s+\S+\s+/,
  /^(?:npx|pnpx|bunx|uvx)(?:\s+(?:-p\s+\S+|--package(?:=\S+|\s+\S+)|--from\s+\S+|--with\s+\S+|-\S+))*\s+/,
  new RegExp(String.raw`^${PACKAGE_MANAGER}${PM_OPTIONS}\s+(?:exec|dlx|x)(?:\s+--)?\s+`),
  new RegExp(
    String.raw`^(?:pnpm|yarn|bun)${PM_OPTIONS}\s+(?=(?:vitest|jest|mocha|ava|playwright|cypress|tsc|vue-tsc|eslint|prettier|prisma|next|nuxt|nuxi|vite|astro|turbo|nx|lerna|webpack|rollup|tsup|esbuild|knex|typeorm|drizzle-kit|sequelize|storybook|wrangler|vercel|netlify|expo|tauri)${END})`,
  ),
  /^(?:uv|poetry|pipenv|hatch|pdm|rye|pixi)\s+run(?:\s+(?:--with\s+\S+|--env\s+\S+|-e\s+\S+|--\S+=\S+|-\S+))*\s+/,
  /^(?:conda|mamba|micromamba)\s+run(?:\s+(?:-n\s+\S+|-p\s+\S+|--\S+|-\S+))*\s+/,
  /^(?:bundle|bundler)\s+exec\s+/,
  /^(?:dotenv|dotenvx\s+run|op\s+run|doppler\s+run|infisical\s+run|aws-vault\s+exec\s+\S+|pass-cli\s+run|direnv\s+exec\s+\S+|devbox\s+run|nix\s+develop\s+(?:.*\s)?--command|mise\s+exec|asdf\s+exec)(?:\s+(?:-e\s+\S+|-f\s+\S+|--\S+|-\S+))*(?:\s+--)?\s+/,
  /^(?:python[0-9.]*|py|pypy[0-9.]*)(?:\s+-[a-zA-Z]+)*\s+-m\s+/,
  /^(?:python[0-9.]*|py|pypy[0-9.]*|node|ruby|php|perl|bun|deno\s+run|tsx|ts-node)(?:\s+-[a-zA-Z-]+)*\s+(?=\S*\.(?:py|js|cjs|mjs|ts|rb|php|pl)(?:\s|$))/,
  /^(?:bash|sh|zsh|dash)(?:\s+-[a-zA-Z]+)*\s+(?=\S+\.(?:sh|bash|zsh)(?:\s|$))/,
  /^(?:docker|podman)\s+(?:compose\s+)?exec(?:\s+(?:-it|-ti|-i|-t|-d|-T|--privileged|-[uwe]\s+\S+|--(?:user|workdir|env)\s+\S+|--\S+=\S+))*\s+\S+\s+/,
];

const SEPARATORS = new Set([";", "|", "&", "\n", "(", ")", "`"]);
const SHELL_NAME = /^(?:bash|sh|zsh|dash|fish)$/;

// Heredoc bodies are data, except when the heredoc feeds a shell.
const stripHeredocs = (command: string): string => {
  const kept: string[] = [];
  let terminator: string | undefined;
  let keepBody = false;
  for (const line of command.split("\n")) {
    if (terminator !== undefined) {
      if (line.trim() === terminator) terminator = undefined;
      else if (keepBody) kept.push(line);
      continue;
    }
    kept.push(line);
    const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (match) {
      terminator = match[2];
      keepBody = /(?:^|[\s;&|(])(?:\S*\/)?(?:bash|sh|zsh|dash)(?:\s+-\S+)*\s*<</.test(line);
    }
  }
  return kept.join("\n");
};

// Split a command into segments of words, honoring quotes and dropping redirections.
const segments = (command: string): string[][] => {
  const result: string[][] = [];
  let current: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | undefined;
  let skipNextWord = false;
  const flushWord = () => {
    if (inWord) {
      if (skipNextWord) skipNextWord = false;
      else current.push(word);
    }
    word = "";
    inWord = false;
  };
  const flushSegment = () => {
    flushWord();
    skipNextWord = false;
    if (current.length > 0) result.push(current);
    current = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      i++;
      if (command[i] !== "\n") {
        word += command[i];
        inWord = true;
      }
    } else if (ch === "#" && !inWord) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (ch === " " || ch === "\t") {
      flushWord();
    } else if (ch === "<" || ch === ">" || two === "&>") {
      // A file-descriptor number directly before the operator belongs to the redirection.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      flushWord();
      while (i + 1 < command.length && /[<>&|0-9-]/.test(command[i + 1]!)) i++;
      if (command[i] !== "&" || command[i - 1] !== ">") skipNextWord = true;
    } else if (two === "$(") {
      flushSegment();
      i++;
    } else if (SEPARATORS.has(ch)) {
      flushSegment();
      if (two === "&&" || two === "||" || two === "|&" || two === ";;") i++;
    } else {
      word += ch;
      inWord = true;
    }
  }
  flushSegment();
  return result;
};

const unwrap = (text: string): string => {
  let current = text;
  for (let pass = 0; pass < 10; pass++) {
    const next = WRAPPERS.reduce((value, wrapper) => value.replace(wrapper, ""), current);
    if (next === current) return current;
    current = next;
  }
  return current;
};

const classifySegment = (segment: string[], depth: number): string | undefined => {
  // `bash -c '<script>'` and `ssh host '<script>'` run their argument as a command.
  const shellIndex = segment.findIndex((word) => SHELL_NAME.test(word.replace(/^.*\//, "")));
  if (shellIndex !== -1 && depth < 3) {
    const flag = segment.findIndex((word, index) => index > shellIndex && /^-[a-zA-Z]*c$/.test(word));
    const script = flag === -1 ? undefined : segment[flag + 1];
    const inner = script === undefined ? undefined : longRunningReason(script, depth + 1);
    if (inner) return inner;
  }
  const text = unwrap(segment.join(" ").trim());
  if (VERSION_OR_HELP.test(text)) return undefined;
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return `${rule.label}: ${text.split(/\s+/).slice(0, 3).join(" ")}`;
  }
  return undefined;
};

/**
 * Returns why a command is known to run long, or undefined when it may run in the foreground.
 */
export const longRunningReason = (command: string, depth = 0): string | undefined => {
  for (const segment of segments(stripHeredocs(command))) {
    const reason = classifySegment(segment, depth);
    if (reason) return reason;
  }
  return undefined;
};
