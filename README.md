# Shopify Media GID CSV Converter

This project contains a Node.js script that replaces image URL values in a Shopify metaobject import CSV with Shopify `gid://shopify/MediaImage/...` values from a Shopify file import report.

The script preserves the import CSV structure and only changes the `Value` column for the field you choose, for example `hero_image`.

## Folder Structure

Put files in these folders:

```text
files/
  map-report/
    designers-images-formatted.csv
  import-csv/
    designers-template.csv
converted/
scripts/
  replace-designer-hero-images.js
```

Use `files/map-report` for Shopify image import report files.

Use `files/import-csv` for metaobject import template files.

The generated CSV and logs are saved in `converted`.

## Required Input Formats

### 1. Shopify Image Import Report

The map report CSV must keep the Shopify file import report format.

Required columns:

```csv
"File Name","Command","Link","Alt Text","Type","ID (Ref)"
```

The script uses:

- `Link` to match the current image URL in the import CSV.
- `File Name` as a fallback match if the URL is not exact.
- `ID (Ref)` as the replacement value.

Example replacement value:

```text
gid://shopify/MediaImage/56036425269619
```

### 2. Metaobject Import CSV

The import CSV must contain these columns:

```csv
Handle,Command,Status,"Definition: Handle",Field,Value
```

The script looks for rows where `Field` equals the field name you provide, then replaces only that row's `Value`.

Example:

```csv
studio-gud,MERGE,Active,designers,hero_image,https://website-craft.s3.amazonaws.com/hero-images/Studio-Gud.jpg
```

Becomes:

```csv
studio-gud,MERGE,Active,designers,hero_image,gid://shopify/MediaImage/56036425269619
```

## What Is Preserved

The script keeps:

- all rows
- all columns
- column order
- row order
- non-target fields
- quoted CSV values
- HTML in description fields
- empty values

Only this is changed:

```text
Value column where Field equals your selected field name
```

For example, if the selected field is `hero_image`, only rows with `Field = hero_image` can change.

## Interactive Use

Run:

```powershell
node scripts/replace-designer-hero-images.js
```

The script will ask:

```text
Map report CSV in files/map-report [designers-images-formatted.csv]:
Import CSV in files/import-csv [designers-template.csv]:
Field value to replace [hero_image]:
Output CSV in converted [designers-template-with-media-gids.csv]:
```

You can press Enter to use the default value shown in brackets.

If you provide only a filename, the script automatically looks in the correct folder.

Example answers:

```text
Map report CSV in files/map-report [designers-images-formatted.csv]: designers-images-formatted.csv
Import CSV in files/import-csv [designers-template.csv]: designers-template.csv
Field value to replace [hero_image]: hero_image
Output CSV in converted [designers-template-with-media-gids.csv]: designers-template-with-media-gids.csv
```

## Command Line Use

You can also provide everything directly:

```powershell
node scripts/replace-designer-hero-images.js --report designers-images-formatted.csv --template designers-template.csv --field hero_image --output designers-template-with-media-gids.csv
```

This reads:

```text
files/map-report/designers-images-formatted.csv
files/import-csv/designers-template.csv
```

And writes:

```text
converted/designers-template-with-media-gids.csv
converted/designers-template-with-media-gids.log
converted/designers-template-with-media-gids.log.json
```

## Options

```text
--report    CSV from files/map-report, or a full/relative path
--template  Import CSV from files/import-csv, or a full/relative path
--field     Field column value to replace, for example hero_image
--output    Output CSV filename in converted, or a full/relative path
--yes       Use defaults for missing options without prompting
--strict    Exit with code 1 when not found / duplicate / skipped rows exist
--help      Show help
```

## Common Examples

Use all defaults:

```powershell
node scripts/replace-designer-hero-images.js --yes
```

Replace `hero_image`:

```powershell
node scripts/replace-designer-hero-images.js --report designers-images-formatted.csv --template designers-template.csv --field hero_image --output designers-template-with-media-gids.csv
```

Replace a different field:

```powershell
node scripts/replace-designer-hero-images.js --report product-images-formatted.csv --template products-template.csv --field thumbnail_image --output products-template-with-media-gids.csv
```

Use strict mode for validation:

```powershell
node scripts/replace-designer-hero-images.js --report designers-images-formatted.csv --template designers-template.csv --field hero_image --output designers-template-with-media-gids.csv --strict
```

Strict mode makes the command fail when there are:

- not found rows
- duplicate map report warnings
- skipped report rows

This is useful for checking data consistency before importing into Shopify.

## Output Files

For an output file named:

```text
designers-template-with-media-gids.csv
```

The script creates:

```text
converted/designers-template-with-media-gids.csv
converted/designers-template-with-media-gids.log
converted/designers-template-with-media-gids.log.json
```

### CSV Output

This is the file to import into Shopify.

### Text Log

This is the human-readable audit log.

It includes:

- total rows
- target field rows
- found count
- replaced count
- not found count
- duplicate warnings
- skipped report rows
- row-by-row match details

Example:

```text
[FOUND] row=3 handle=studio-gud field=hero_image match=exact URL value="https://..." -> "gid://shopify/MediaImage/..."
[NOT FOUND] row=1043 handle=daniel-libeskind field=hero_image reason="empty hero_image value" value=""
```

### JSON Log

This contains the same audit information in JSON format.

Use it if you want to filter, search, or process the result programmatically.

## Match Logic

The script tries to find the Shopify MediaImage GID in this order:

1. Exact match using the image URL.
2. Fallback match using the image filename.

Example:

```text
https://website-craft.s3.amazonaws.com/hero-images/Studio-Gud.jpg
```

Can match report file name:

```text
Studio-Gud.jpg
```

## Not Found Rows

`NOT FOUND` means the script could not replace that row.

Common reasons:

- the target field value is empty
- the image URL does not exist in the map report
- the filename does not exist in the map report
- the map report row has no valid `gid://shopify/MediaImage/...` value

The script keeps not found values unchanged in the output CSV.

## Duplicate Warnings

Duplicate warnings mean the map report has more than one MediaImage GID for the same link or filename.

The script keeps the first mapping it saw and logs the duplicate for review.

If duplicate handling must be stricter, run with:

```powershell
node scripts/replace-designer-hero-images.js --strict
```

## Safe Workflow

Recommended workflow:

1. Put the Shopify image import report in `files/map-report`.
2. Put the Shopify metaobject import CSV in `files/import-csv`.
3. Run the script.
4. Open the `.log` file in `converted`.
5. Review `NOT FOUND` and `DUPLICATE` entries.
6. Import the generated CSV from `converted` into Shopify.

## Current Designer Example

For the current designer files:

```powershell
node scripts/replace-designer-hero-images.js --report designers-images-formatted.csv --template designers-template.csv --field hero_image --output designers-template-with-media-gids.csv
```

Expected output summary:

```text
Target rows=1007, found=1002, replaced=1002, notFound=5
```

