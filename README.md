# Scrape.ly GitHub Action

Run a [Scrape.ly](https://scrape.ly) Actor or saved task from a GitHub workflow, wait for it to finish, and use its results: save them to a file, commit them, or pass them to the next step.

```yaml
- uses: scrapely-app/scrapely-action@v1
  with:
    api-token: ${{ secrets.SCRAPELY_TOKEN }}
    actor: username/actor-name
    input: '{"maxItems": 100}'
    output-file: data/results.json
```

Create an API key in the Scrape.ly dashboard under **Settings → API & Integrations** and add it to your repository as the secret `SCRAPELY_TOKEN` (**Settings → Secrets and variables → Actions**). A scoped key needs `actors:run`, `runs:read`, and `datasets:read`.

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-token` | required | Your Scrape.ly API key. |
| `actor` | | Actor ID or `username/actor-name`. Set this or `task`. |
| `task` | | Saved task ID. Set this or `actor`. |
| `input` | `{}` | Run input as JSON. For a task, fields you set override the matching fields of its saved input. |
| `input-file` | | Path to a JSON file with the run input, instead of `input`. |
| `wait` | `true` | Wait for the run to finish. |
| `max-wait` | `3600` | Seconds to wait before the step fails. |
| `build` | | Build tag or number, for example `latest`. |
| `memory` | | Memory for the run in MB. |
| `timeout` | | Stop the run after this many seconds. |
| `output-file` | | Save the results to this file. |
| `output-format` | `json` | `json`, `jsonl` or `csv`. |
| `max-items` | `1000` | Max number of results to fetch. |
| `fail-on-error` | `true` | Fail the step when the run does not succeed. |
| `base-url` | `https://api.scrape.ly` | API address. |

## Outputs

| Output | Description |
|---|---|
| `run-id` | ID of the run. |
| `status` | Final status, for example `SUCCEEDED` or `FAILED`. |
| `dataset-id` | ID of the run's dataset. |
| `key-value-store-id` | ID of the run's key-value store. |
| `items-count` | Number of results fetched. |
| `items` | The results as a JSON array, when smaller than 1 MB. |

The step also writes a summary of the run to the workflow page.

## Examples

### Scrape on a schedule and commit the results

```yaml
name: Daily scrape
on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch:

permissions:
  contents: write

jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: scrapely-app/scrapely-action@v1
        with:
          api-token: ${{ secrets.SCRAPELY_TOKEN }}
          actor: username/actor-name
          input: '{"maxItems": 500}'
          output-file: data/results.csv
          output-format: csv
      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/results.csv
          git commit -m "Update scraped data" || echo "No changes"
          git push
```

### Use the results in the next step

```yaml
- uses: scrapely-app/scrapely-action@v1
  id: scrape
  with:
    api-token: ${{ secrets.SCRAPELY_TOKEN }}
    actor: username/actor-name
- run: echo '${{ steps.scrape.outputs.items }}' | jq length
- run: echo "Run ${{ steps.scrape.outputs.run-id }} returned ${{ steps.scrape.outputs.items-count }} results"
```

### Run a saved task without waiting

```yaml
- uses: scrapely-app/scrapely-action@v1
  with:
    api-token: ${{ secrets.SCRAPELY_TOKEN }}
    task: YOUR_TASK_ID
    wait: false
```

## License

[MIT](LICENSE)
