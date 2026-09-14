@@
 rows.sort((a, b) => b.triples - a.triples);
+
+// Competition ranking: equal totals share a rank and the next rank
+// skips the tied positions (for example, 1, 2, 2, 4).
 const rankedRows = rows.map((row, index) => ({
   ...row,
-  rank: index + 1, //craziest bug ever made actually
+  rank:
+    index === 0 || row.triples !== rows[index - 1].triples
+      ? index + 1
+      : null,
 }));
+for (let index = 1; index < rankedRows.length; index += 1) {
+  if (rankedRows[index].rank == null) {
+    rankedRows[index].rank = rankedRows[index - 1].rank;
+  }
+}
@@
 return {
-  rank: index + 1,
+  rank: rankedRows[index].rank,


