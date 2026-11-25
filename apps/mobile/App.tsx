import React, { useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, Text, View, TouchableOpacity, StyleSheet } from 'react-native';

const API_BASE = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:8787';

export default function App() {
  const [products, setProducts] = useState<any[]>([]);
  const [cart, setCart] = useState<any[]>([]);

  useEffect(() => {
    fetch(`${API_BASE}/api/v1/products?limit=20`)
      .then((r) => r.json())
      .then((d) => setProducts(d.products || []))
      .catch(() => {});
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.wordmark}>BrandSpot</Text>
        <Text style={styles.sub}>All Brands. One Spot. · Cart ({cart.length})</Text>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {products.map((p) => (
          <View key={p.id} style={styles.card}>
            <Text style={styles.brand}>{p.brand_name}</Text>
            <Text style={styles.title}>{p.title}</Text>
            <Text style={styles.price}>PKR {Number(p.sale_price_pkr).toLocaleString()}</Text>
            {p.is_direct_buy ? (
              <TouchableOpacity style={styles.btn} onPress={() => setCart([...cart, p])}>
                <Text style={styles.btnText}>Add to Cart</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: { padding: 20, borderBottomWidth: 1, borderBottomColor: 'rgba(244,242,239,0.28)' },
  wordmark: { color: '#f4f2ef', fontSize: 26, fontFamily: 'serif' },
  sub: { color: '#8c8783', fontSize: 12, marginTop: 4 },
  list: { padding: 16, gap: 12 },
  card: { padding: 16, borderWidth: 1, borderColor: 'rgba(244,242,239,0.2)', borderRadius: 3 },
  brand: { color: '#8c8783', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.5 },
  title: { color: '#f4f2ef', fontSize: 18, marginTop: 4, fontFamily: 'serif' },
  price: { color: '#f4f2ef', fontSize: 14, marginTop: 6 },
  btn: { marginTop: 10, backgroundColor: '#f4f2ef', paddingVertical: 8, paddingHorizontal: 14, alignSelf: 'flex-start', borderRadius: 3 },
  btnText: { color: '#000', fontSize: 12, fontWeight: '500' }
});
