import { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { mark } from 'doubletake/sdk';

// EXPO_PUBLIC_SLOW=1 builds the "before" app: it blocks the JS thread at startup and renders heavy rows.
const SLOW = process.env.EXPO_PUBLIC_SLOW === '1';

function busy(ms: number): number {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 1);
  return x;
}

const rows = Array.from({ length: 2000 }, (_, i) => ({ id: String(i), title: `Row ${i}` }));

function Row({ title }: { title: string }) {
  if (SLOW) busy(4);
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
    </View>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (SLOW) busy(300);
    setReady(true);
  }, []);
  useEffect(() => {
    if (ready) requestAnimationFrame(() => mark('home'));
  }, [ready]);
  if (!ready) return <View style={styles.screen} />;
  return (
    <FlatList
      testID="list"
      style={styles.screen}
      data={rows}
      keyExtractor={(row) => row.id}
      renderItem={({ item }) => <Row title={item.title} />}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  row: { height: 64, justifyContent: 'center', paddingHorizontal: 20, borderBottomWidth: 1, borderColor: '#eee' },
  title: { fontSize: 17 },
});
