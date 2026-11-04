import com.mulesoft.modules.configuration.properties.api.*;
import java.util.Base64;
// Reference values from Mule's own encrypter, every algorithm here x mode x random IVs, with made-up test keys.
public class SecureFixtures {
  public static void main(String[] a) throws Exception {
    java.security.Security.addProvider(new org.bouncycastle.jce.provider.BouncyCastleProvider());   // as the Mule runtime has it
    String[][] keys = {
      {"AES", "TestKey123456789"}, {"AES", "TestKey123456789TestKey1"}, {"AES", "TestKey123456789TestKey123456789"},
      {"Rijndael", "TestKey123456789"}, {"Blowfish", "TestKey123456789"}, {"Blowfish", "TestKey1"},
      {"DES", "TestKey1"}, {"DESede", "TestKey123456789TestKey1"},
    };
    String text = "s3cr3t-värde with spaces & symbols ✓";
    StringBuilder out = new StringBuilder("[");
    for (String[] k : keys) for (EncryptionMode mode : EncryptionMode.values()) for (boolean random : new boolean[] {false, true}) {
      try {
        org.mule.encryption.Encrypter e = EncryptionAlgorithm.valueOf(k[0]).getBuilder().using(mode).forKey(k[1]).useRandomIVs(random).build();
        String c = Base64.getEncoder().encodeToString(e.encrypt(text.getBytes("UTF-8")));
        if (out.length() > 1) out.append(",\n");
        out.append(String.format("{\"algorithm\":\"%s\",\"mode\":\"%s\",\"random\":%s,\"key\":\"%s\",\"cipher\":\"%s\"}", k[0], mode, random, k[1], c));
      } catch (Throwable ex) { System.err.println(k[0] + " " + k[1].length() + " " + mode + " " + random + ": " + ex); }
    }
    System.out.println(out.append("]"));
  }
}
