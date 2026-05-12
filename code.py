import gzip
import shutil

with open("fires_small.csv", "rb") as f_in:
    with gzip.open("fires_small.csv.gz", "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)

print("done")